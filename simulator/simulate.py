"""Vigil traffic simulator. Everything it produces is SYNTHETIC.

It sends transactions to the Vigil API as a bank core system would, mixing normal traffic with
injected fraud patterns that the rules engine is built to catch, then reports the "true" label
for each fraud transaction back later (like a chargeback feed arriving days after the fact).

Usage:
  SERVICE_KEY=... API_URL=https://... python simulator/simulate.py --count 40
  python simulator/simulate.py --paysim PS_20174392719_1491204439457_log.csv --count 200   # optional PaySim CSV

PaySim (Lopez-Rojas et al.) is an optional, separately downloaded synthetic dataset; this repo does not ship it.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

CHANNELS = ["UPI", "CARD", "NETBANKING", "WALLET"]
STATE_FILE = Path(os.environ.get("PENDING_LABELS_FILE", "pending_labels.json"))


class Api:
    def __init__(self, base: str, key: str):
        self.base = base.rstrip("/")
        self.s = requests.Session()
        self.s.headers.update({"X-Service-Key": key})

    def _req(self, method: str, path: str, **kw):
        # A free-tier host may be asleep: give the first request time, then retry transient failures.
        for attempt in range(4):
            try:
                r = self.s.request(method, self.base + path, timeout=75 if attempt == 0 else 30, **kw)
                if r.status_code >= 500:
                    raise requests.HTTPError(f"{r.status_code}")
                return r
            except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt * 3)
        raise RuntimeError("unreachable")

    def accounts(self) -> list[dict]:
        out, cursor = [], None
        while True:
            r = self._req("GET", "/accounts", params={"limit": 500, **({"cursor": cursor} if cursor else {})})
            r.raise_for_status()
            body = r.json()
            out += body["items"]
            cursor = body["next_cursor"]
            if not cursor:
                return out

    def ingest(self, payload: dict) -> dict | None:
        r = self._req("POST", "/transactions", json=payload)
        if r.status_code in (200, 201):
            return r.json()
        print(f"  ingest rejected {r.status_code}: {r.text[:200]}", file=sys.stderr)
        return None

    def labels(self, labels: list[dict]) -> dict:
        r = self._req("POST", "/ground-truth", json={"labels": labels})
        r.raise_for_status()
        return r.json()


def money(x: float) -> str:
    return f"{x:.2f}"


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat()


class LimitReached(Exception):
    """Raised inside a batch once the batch's quota of transactions has been sent."""


class Sim:
    def __init__(self, api: Api, rng: random.Random):
        self.api, self.rng = api, rng
        self.limit = float("inf")
        accts = [a for a in api.accounts() if a["status"] == "active"]
        self.customers = [a for a in accts if a["kind"] == "customer"]
        self.merchants = [a for a in accts if a["kind"] == "merchant"]
        if len(self.customers) < 5 or not self.merchants:
            raise SystemExit("Not enough accounts. Run `npm run db:seed` first.")
        self.pending: list[dict] = []  # fraud transactions awaiting their delayed label
        self.sent = 0

    def ref(self) -> str:
        return f"sim-{uuid.uuid4().hex[:16]}"

    def send(self, frm, to, ttype, amount, *, city=None, at=None, fraud=False, channel=None):
        if self.sent >= self.limit:
            raise LimitReached
        bal = round(self.rng.uniform(amount, amount * 6 + 5000), 2)
        drained = fraud and ttype in ("TRANSFER", "CASH_OUT") and self.rng.random() < 0.7
        p = {
            "external_ref": self.ref(),
            "from_account_id": frm["id"],
            "to_account_id": to["id"],
            "type": ttype,
            "channel": channel or self.rng.choice(CHANNELS),
            "amount": money(amount),
            "old_balance_orig": money(bal),
            "new_balance_orig": money(0 if drained else max(bal - amount, 0)),
            "old_balance_dest": money(0 if to["kind"] == "customer" and fraud else self.rng.uniform(0, 80000)),
            "new_balance_dest": money(amount if fraud else self.rng.uniform(0, 90000)),
            "ip_city": city or frm["city"],
            "device_id": f"dev-{frm['id']}",
        }
        if at:
            p["created_at"] = iso(at)
        res = self.api.ingest(p)
        if res is None:
            return None
        self.sent += 1
        if fraud:
            self.pending.append({"external_ref": p["external_ref"], "is_fraud": True, "due": iso(now() + timedelta(hours=self.rng.randint(2, 30)))})
        return res

    # ---- normal behaviour ----
    def normal(self):
        frm = self.rng.choice(self.customers)
        if self.rng.random() < 0.7:
            to, t = self.rng.choice(self.merchants), "PAYMENT"
            amt = min(self.rng.lognormvariate(6.2, 0.9), 40000)
        else:
            to, t = self.rng.choice([c for c in self.customers if c["id"] != frm["id"]]), "TRANSFER"
            amt = min(self.rng.lognormvariate(7.0, 1.0), 60000)
        # a small share of honest-but-odd traffic so analysts also see false positives
        city = self.rng.choice([c["city"] for c in self.customers]) if self.rng.random() < 0.02 else None
        self.send(frm, to, t, round(amt, 2), city=city)

    # ---- injected patterns (labelled fraud) ----
    def velocity(self):
        frm = self.rng.choice(self.customers)
        for _ in range(self.rng.randint(5, 7)):
            self.send(frm, self.rng.choice(self.merchants), "PAYMENT", round(self.rng.uniform(300, 4000), 2), fraud=True)

    def new_city(self):
        frm = self.rng.choice(self.customers)
        for _ in range(3):  # establish a home pattern first, back-dated
            self.send(frm, self.rng.choice(self.merchants), "PAYMENT", round(self.rng.uniform(200, 2500), 2),
                      at=now() - timedelta(minutes=self.rng.randint(5, 40)))
        far = self.rng.choice([c["city"] for c in self.customers if c["city"] != frm["city"]])
        self.send(frm, self.rng.choice(self.merchants), "PAYMENT", round(self.rng.uniform(8000, 30000), 2), city=far, fraud=True)

    def spike(self):
        frm = self.rng.choice(self.customers)
        for d in range(1, 5):  # a modest history over previous days
            self.send(frm, self.rng.choice(self.merchants), "PAYMENT", round(self.rng.uniform(300, 1500), 2),
                      at=now() - timedelta(days=d, hours=self.rng.randint(0, 5)))
        self.send(frm, self.rng.choice(self.merchants), "PAYMENT", round(self.rng.uniform(25000, 90000), 2), fraud=True)

    def dormant(self):
        frm = self.rng.choice(self.customers)
        self.send(frm, self.rng.choice(self.merchants), "PAYMENT", 450.0, at=now() - timedelta(days=self.rng.randint(120, 200)))
        mule = self.rng.choice([c for c in self.customers if c["id"] != frm["id"]])
        self.send(frm, mule, "TRANSFER", round(self.rng.uniform(60000, 150000), 2), fraud=True, channel="NETBANKING")

    def run(self, count: int, fraud_rate: float):
        """Send exactly `count` more transactions (a fraud pattern cut short by the quota is fine)."""
        patterns = [self.velocity, self.new_city, self.spike, self.dormant]
        self.limit = self.sent + count
        try:
            while self.sent < self.limit:
                if self.rng.random() < fraud_rate:
                    self.rng.choice(patterns)()
                else:
                    self.normal()
        except LimitReached:
            pass


def paysim_rows(path: str, limit: int):
    """Optional: map PaySim rows onto our schema (synthetic data by the PaySim authors)."""
    with open(path, newline="") as f:
        for i, row in enumerate(csv.DictReader(f)):
            if i >= limit:
                return
            yield row


PS_TYPE = {"PAYMENT": "PAYMENT", "TRANSFER": "TRANSFER", "CASH_OUT": "CASH_OUT", "CASH_IN": "CASH_IN", "DEBIT": "DEBIT"}


def run_paysim(sim: Sim, path: str, count: int):
    for row in paysim_rows(path, count):
        frm = sim.rng.choice(sim.customers)
        to = sim.rng.choice(sim.merchants if row["type"] == "PAYMENT" else [c for c in sim.customers if c["id"] != frm["id"]])
        amount = float(row["amount"])
        if amount <= 0:
            continue
        sim.send(frm, to, PS_TYPE.get(row["type"], "PAYMENT"), min(amount, 5_000_000), fraud=row.get("isFraud") == "1")


def load_pending() -> list[dict]:
    try:
        return json.loads(STATE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def release_labels(api: Api, pending: list[dict]) -> list[dict]:
    """Send labels whose delay has elapsed. Honest labels for the injected fraud only."""
    due = [p for p in pending if p["due"] <= iso(now())]
    keep = [p for p in pending if p["due"] > iso(now())]
    if due:
        res = api.labels([{"external_ref": p["external_ref"], "is_fraud": p["is_fraud"]} for p in due])
        print(f"released {len(due)} delayed labels ({res['inserted']} new)")
    return keep


def main():
    ap = argparse.ArgumentParser(description="Send synthetic transactions to Vigil")
    ap.add_argument("--count", type=int, default=int(os.environ.get("SIM_COUNT", 40)))
    ap.add_argument("--fraud-rate", type=float, default=float(os.environ.get("SIM_FRAUD_RATE", 0.08)))
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--paysim", help="optional path to a PaySim CSV")
    ap.add_argument("--total", type=int, default=0, help="keep going in batches of --count until this many are sent")
    ap.add_argument("--interval", type=int, default=60, help="seconds between batches when --total is used")
    a = ap.parse_args()

    base, key = os.environ.get("API_URL"), os.environ.get("SERVICE_KEY")
    if not base or not key:
        raise SystemExit("Set API_URL and SERVICE_KEY")
    api = Api(base, key)
    sim = Sim(api, random.Random(a.seed))
    pending = load_pending()

    def batch(n: int):
        nonlocal pending
        if a.paysim:
            run_paysim(sim, a.paysim, n)
        else:
            sim.run(n, a.fraud_rate)
        pending = release_labels(api, pending) + sim.pending
        sim.pending = []
        STATE_FILE.write_text(json.dumps(pending))

    if a.total <= 0:
        batch(a.count)
        print(f"sent {sim.sent} synthetic transactions; {len(pending)} labels still pending")
        return

    # Test mode: a steady stream (default 20 per minute) until --total transactions have been sent.
    try:
        while sim.sent < a.total:
            started = time.monotonic()
            batch(min(a.count, a.total - sim.sent))
            print(f"{sim.sent}/{a.total} sent", flush=True)
            if sim.sent < a.total:
                time.sleep(max(0, a.interval - (time.monotonic() - started)))
    except KeyboardInterrupt:
        print(f"\nstopped early at {sim.sent} transactions")
        return
    print(f"done: {sim.sent} synthetic transactions sent; {len(pending)} labels still pending")


if __name__ == "__main__":
    main()
