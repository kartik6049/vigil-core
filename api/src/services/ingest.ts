import { writeAudit } from '../audit.js';
import { withTx } from '../db.js';
import { HttpError } from '../errors.js';
import { runRules } from '../rules/engine.js';
import type { RuleRow } from '../rules/engine.js';
import { getTransaction, getTransactionByRef } from '../serialize.js';
import type { TxnOut } from '../serialize.js';
import type { AppDeps } from '../types.js';

export interface IngestInput {
  external_ref: string;
  from_account_id: number;
  to_account_id: number;
  type: string;
  channel: string;
  amount: string;
  old_balance_orig?: string | null;
  new_balance_orig?: string | null;
  old_balance_dest?: string | null;
  new_balance_dest?: string | null;
  ip_city?: string | null;
  device_id?: string | null;
  created_at?: string;
}

export interface CaseRef {
  id: number;
  priority: number;
  status: string;
}

export interface IngestResult {
  created: boolean;
  transaction: TxnOut;
  case: CaseRef | null;
}

const istHour = (iso: string): number =>
  Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(iso),
    ),
  );

const num = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

async function existingResult(deps: AppDeps, transaction: TxnOut): Promise<IngestResult> {
  const c = await deps.pool.query('select id, priority, status from cases where transaction_id = $1', [transaction.id]);
  return { created: false, transaction, case: (c.rows[0] as CaseRef | undefined) ?? null };
}

/**
 * Score -> rules -> decide -> write, exactly once per external_ref.
 *
 * Idempotency has two layers: a cheap lookup up front (so a retry skips the ML call),
 * and ON CONFLICT DO NOTHING on the unique external_ref (so two simultaneous retries
 * cannot both insert).
 */
export async function ingestTransaction(deps: AppDeps, input: IngestInput): Promise<IngestResult> {
  const { pool, scorer, hub, notifier } = deps;

  const already = await getTransactionByRef(pool, input.external_ref);
  if (already) return existingResult(deps, already);

  if (input.from_account_id === input.to_account_id) {
    throw new HttpError(422, 'invalid_account', 'from_account_id and to_account_id must differ');
  }
  const acc = await pool.query('select id, status from accounts where id = any($1::bigint[])', [
    [input.from_account_id, input.to_account_id],
  ]);
  const status = new Map<number, string>(acc.rows.map((r) => [r.id as number, r.status as string]));
  if (!status.has(input.from_account_id) || !status.has(input.to_account_id)) {
    throw new HttpError(422, 'invalid_account', 'Unknown from_account_id or to_account_id');
  }
  const fromBlocked = status.get(input.from_account_id) === 'blocked';

  const createdAt = input.created_at ?? new Date().toISOString();
  const ruleRows = (await pool.query('select id, name, params, enabled from rules where enabled order by id'))
    .rows as RuleRow[];

  // Model and rules are independent, so run them concurrently.
  const [score, hits] = await Promise.all([
    scorer({
      transaction_id: input.external_ref,
      type: input.type,
      amount: Number(input.amount),
      hour_of_day: istHour(createdAt),
      old_balance_orig: num(input.old_balance_orig),
      new_balance_orig: num(input.new_balance_orig),
      old_balance_dest: num(input.old_balance_dest),
      new_balance_dest: num(input.new_balance_dest),
    }),
    runRules(pool, ruleRows, {
      fromAccountId: input.from_account_id,
      type: input.type,
      amount: input.amount,
      ipCity: input.ip_city ?? null,
      createdAt,
    }),
  ]);

  const reasons: unknown[] = [
    ...(score ? score.reasons.map((r) => ({ source: 'model', ...r })) : [{ source: 'system', feature: 'model_unavailable' }]),
    ...hits.map((h) => ({ source: 'rule', rule: h.rule, detail: h.detail })),
    ...(fromBlocked ? [{ source: 'system', feature: 'account_blocked' }] : []),
  ];

  // Decision logic from the shared contract:
  //   flagged  = model band is high OR any rule fires
  //   priority = 1 when both, otherwise 2
  const modelHigh = score?.risk_band === 'high';
  const ruleFired = hits.length > 0 || fromBlocked;
  const flagged = modelHigh || ruleFired;
  const priority = modelHigh && ruleFired ? 1 : 2;

  const written = await withTx(pool, async (c) => {
    const ins = await c.query(
      `insert into transactions
         (external_ref, from_account_id, to_account_id, type, channel, amount,
          old_balance_orig, new_balance_orig, old_balance_dest, new_balance_dest,
          ip_city, device_id, created_at, risk_score, risk_band, model_version, reasons, status)
       values ($1,$2,$3,$4::txn_type,$5::txn_channel,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,
               $14,$15::risk_band,$16,$17::jsonb,$18::txn_status)
       on conflict (external_ref) do nothing
       returning id`,
      [
        input.external_ref, input.from_account_id, input.to_account_id, input.type, input.channel, input.amount,
        input.old_balance_orig ?? null, input.new_balance_orig ?? null,
        input.old_balance_dest ?? null, input.new_balance_dest ?? null,
        input.ip_city ?? null, input.device_id ?? null, createdAt,
        score ? score.risk_score : null, score ? score.risk_band : null, score ? score.model_version : null,
        JSON.stringify(reasons), flagged ? 'flagged' : 'approved',
      ],
    );
    if (ins.rowCount === 0) return null; // a concurrent request with the same ref won the race

    const id = ins.rows[0].id as number;
    let caseRef: CaseRef | null = null;
    if (flagged) {
      const cs = await c.query(
        'insert into cases (transaction_id, priority) values ($1, $2) returning id, priority, status',
        [id, priority],
      );
      caseRef = cs.rows[0] as CaseRef;
      await writeAudit(c, {
        actorId: null,
        action: 'case.open',
        entityType: 'case',
        entityId: String(caseRef.id),
        after: { transaction_id: id, priority, status: 'open' },
      });
    }
    return { id, caseRef };
  });

  if (!written) {
    const winner = await getTransactionByRef(pool, input.external_ref);
    if (!winner) throw new HttpError(500, 'internal_error', 'Idempotent insert lost its row');
    return existingResult(deps, winner);
  }

  const transaction = (await getTransaction(pool, written.id))!;
  hub.publish('txn.new', transaction);
  if (written.caseRef) {
    hub.publish('txn.flagged', { transaction, case: written.caseRef });
    if (written.caseRef.priority === 1) {
      // Phase 3 plugs Firebase push in here. Failures must never fail ingest.
      notifier
        .priorityCaseOpened({ caseId: written.caseRef.id, transactionId: written.id })
        .catch((err) => console.error('notifier failed', err));
    }
  }
  return { created: true, transaction, case: written.caseRef };
}
