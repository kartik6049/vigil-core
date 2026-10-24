Measured on PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), 2 vCPU, 1000000 synthetic transactions, 30442 cases (300 live). Median of 7 warm runs of `EXPLAIN (ANALYZE, BUFFERS)`, execution time only.

| Query | Before | After | Change |
|---|---|---|---|
| Velocity rule, one account, 10-minute window | 0.103 ms | 0.072 ms | 1.4x |
| Account history, last 20 transactions | 0.440 ms | 0.195 ms | 2.3x |
| Case queue (50 live cases, priority then age) | 2.768 ms | 0.060 ms | 46.1x |
| 7-day hourly chart | 155.927 ms | 0.187 ms | 833.8x |

Plans (first lines):
- history before: Limit (cost=7.20..143.48 rows=20 width=16)  -> Incremental Sort (cost=7.20..45175.73 rows=6629 width=16)  Sort
- history after: Limit (cost=3.79..71.88 rows=20 width=16)  -> Incremental Sort (cost=3.79..22599.22 rows=6637 width=16)  Sort 
- queue before: Limit (cost=736.46..736.58 rows=50 width=18)  -> Sort (cost=736.46..737.21 rows=299 width=18)  Sort Key: prior
- queue after: Limit (cost=0.27..70.02 rows=50 width=18)  -> Index Scan using cases_queue_idx on cases c (cost=0.27..417.37 r
