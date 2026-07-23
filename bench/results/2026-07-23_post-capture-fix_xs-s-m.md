# Mobile perf baseline — Layer 1 & 2 results

Run: `2026-07-23_post-capture-fix_xs-s-m` (after the capture-batching fix) · Node v26.4.0

> Layer-1 wall/heap are **relative** signals (this machine, not a phone). Layer-2 counts are **exact and device-independent**. Absolute on-device time = Layer-3 (perfLog), recorded separately.

Profiles run: XS(F=50,B=2048), S(F=500,B=4096), M(F=2000,B=6144)

## B1

_hashes/read ≈ F? (F=50)_

| variant | fileReads | sha256 | metaWrites | bytesWritten | roundMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|
| XS F=50 | 50 | 51 | 5 | 113 | 7.3 | 1.0 |
| S F=500 | 500 | 501 | 5 | 114 | 42.2 | 8.6 |
| M F=2000 | 2000 | 2001 | 5 | 115 | 155.5 | 8.5 |

## B2

_mergeBase super-linear in lineage depth?_

| variant | dagMergeBase | dagIsAncestor | dagReachable | sha256 | mergeRoundMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|
| deep-history K=20 H≈400 | 441 | 461 | 8440 | 8922 | 1267.4 | 17.9 |
| deep-history K=50 H≈1000 | 1041 | 1061 | 20440 | 21522 | 4195.7 | 13.3 |

## B3

_O(F·B) hash + up to O(F²) registry bytes_

| variant | sha256 | fileReads | metaWrites | registryBytes | fsSyscalls | captureMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|--:|
| XS F=50 | 50 | 50 | 53 | 181324 | 159 | 4.4 | 3.6 |
| S F=500 | 500 | 500 | 509 | 3680621 | 1527 | 44.5 | 24.9 |
| M F=2000 | 2000 | 2000 | 2032 | 26556558 | 6096 | 264.9 | 41.2 |

## B4

_O(H) decrypts + O(H) in-memory ops on first join_

| variant | aesDecrypt | sha256 | metaWrites | metaAppends | coldPullMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|
| join H≈420 (ops=420) | 441 | 61 | 43 | 1 | 27.4 | 10.6 |
| join H≈1020 (ops=1020) | 1041 | 61 | 44 | 1 | 57.4 | 23.6 |

## B5

_registry rewrites O(F) per file → O(F²) per batch; journal is delta-sized_

| variant | metaWrites | metaAppends | metaRemoves | fsSyscalls | bytesWritten | bytesAppended | writesPerFile |
|---|--:|--:|--:|--:|--:|--:|--:|
| XS batch-capture F=50 | 53 | 0 | 0 | 159 | 181324 | 0 | 1.1 |
| S batch-capture F=500 | 509 | 0 | 0 | 1527 | 3680621 | 0 | 1 |
| M batch-capture F=2000 | 2032 | 0 | 0 | 6096 | 26556558 | 0 | 1 |

## B6

_ContentStore.memCache never cleared → post-GC heap grows toward total distinct content_

| variant | heapStartMB | heapEndMB | heapGrowthMB | rssGrowthMB |
|---|--:|--:|--:|--:|
| XS 50 rounds | 14.2 | 14.6 | 0.4 | 0.0 |
| S 50 rounds | 17.9 | 20.2 | 2.3 | 1.2 |
| M 50 rounds | 35.5 | 43.9 | 8.3 | -28.0 |

## B7

_fold loop re-runs buildLocalState+recordVersionEdges per fold (superlinear in C)_

| variant | fileReads | dagLeaves | dagMergeBase | sha256 | foldRoundMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|
| wide-concurrency C=3 | 7 | 6 | 7 | 17 | 10.8 | 0.5 |
| wide-concurrency C=5 | 9 | 8 | 9 | 21 | 12.6 | 0.6 |
| wide-concurrency C=10 | 14 | 13 | 14 | 31 | 20.2 | 1.2 |

## B8

_normal file ≈ O(L)_

| variant | conflicts | mergeMs |
|---|--:|--:|
| big-file 64KB unique | 4 | 1.5 |
| big-file 256KB unique | 14 | 8.6 |
| big-file 1024KB unique | 53 | 67.7 |
| low-unique 1000 lines | 0 | 16.8 |
| low-unique 4000 lines | 0 | 314.9 |
| low-unique 8000 lines | 0 | 1343.4 |

## B9

_fixed one-time cost_

| variant | deriveMs | encryptOpMs | encryptBlobMs | blindHashMs | sha256Ms |
|---|--:|--:|--:|--:|--:|
| PBKDF2 derive (one-time) | 28.1 |  |  |  |  |
| AES-GCM per op |  | 0.1 |  |  |  |
| blob 64KB |  |  | 0.1 | 0.1 | 0.1 |
| blob 1024KB |  |  | 0.6 | 0.1 | 0.8 |
| blob 5120KB |  |  | 8.6 | 0.2 | 4.0 |

