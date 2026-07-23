# Mobile perf baseline — Layer 1 & 2 results

Run: `2026-07-23_xs-s-m` · Node v26.4.0

> Layer-1 wall/heap are **relative** signals (this machine, not a phone). Layer-2 counts are **exact and device-independent**. Absolute on-device time = Layer-3 (perfLog), recorded separately.

Profiles run: XS(F=50,B=2048), S(F=500,B=4096), M(F=2000,B=6144)

## B1

_hashes/read ≈ F? (F=50)_

| variant | fileReads | sha256 | metaWrites | bytesWritten | roundMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|
| XS F=50 | 50 | 51 | 5 | 113 | 17.5 | 1.0 |
| S F=500 | 500 | 501 | 5 | 114 | 120.7 | 8.6 |
| M F=2000 | 2000 | 2001 | 5 | 115 | 483.9 | 8.4 |

## B2

_mergeBase super-linear in lineage depth?_

| variant | dagMergeBase | dagIsAncestor | dagReachable | sha256 | mergeRoundMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|
| deep-history K=20 H≈400 | 40 | 270 | 440 | 521 | 411.6 | 10.2 |
| deep-history K=50 H≈1000 | 40 | 270 | 440 | 521 | 711.1 | 21.8 |

## B2b

_common ≈ K → mergeBase O(common²) filter bites: isAncPerBase climbs ~2K, mergeBase/reads flat_

| variant | dagMergeBase | dagIsAncestor | isAncPerBase | dagReachable | fileReads | mergeRoundMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|--:|
| deep-shared-backbone K=20 H≈400 | 40 | 270 | 6.75 | 440 | 460 | 379.3 | 20.0 |
| deep-shared-backbone K=50 H≈1000 | 40 | 270 | 6.75 | 440 | 460 | 721.2 | 13.2 |

## B3

_O(F·B) hash + up to O(F²) registry bytes_

| variant | sha256 | fileReads | metaWrites | registryBytes | fsSyscalls | captureMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|--:|
| XS F=50 | 50 | 50 | 53 | 183465 | 159 | 16.3 | 4.2 |
| S F=500 | 500 | 500 | 509 | 3728697 | 1527 | 124.9 | 25.5 |
| M F=2000 | 2000 | 2000 | 2032 | 27042484 | 6096 | 913.6 | 49.1 |

## B4

_O(H) decrypts + O(H) in-memory ops on first join_

| variant | aesDecrypt | sha256 | metaWrites | metaAppends | coldPullMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|
| join H≈420 (ops=420) | 441 | 61 | 43 | 1 | 76.8 | 10.6 |
| join H≈1020 (ops=1020) | 1041 | 61 | 44 | 1 | 173.2 | 23.5 |

## B5

_registry rewrites O(F) per file → O(F²) per batch; journal is delta-sized_

| variant | metaWrites | metaAppends | metaRemoves | fsSyscalls | bytesWritten | bytesAppended | writesPerFile |
|---|--:|--:|--:|--:|--:|--:|--:|
| XS batch-capture F=50 | 53 | 0 | 0 | 159 | 183465 | 0 | 1.1 |
| S batch-capture F=500 | 509 | 0 | 0 | 1527 | 3728697 | 0 | 1 |
| M batch-capture F=2000 | 2032 | 0 | 0 | 6096 | 27042484 | 0 | 1 |

## B6

_ContentStore.memCache never cleared → post-GC heap grows toward total distinct content_

| variant | heapStartMB | heapEndMB | heapGrowthMB | rssGrowthMB |
|---|--:|--:|--:|--:|
| XS 50 rounds | 15.8 | 16.3 | 0.5 | -0.3 |
| S 50 rounds | 19.7 | 22.1 | 2.3 | -0.0 |
| M 50 rounds | 37.5 | 45.8 | 8.3 | -26.0 |

## B7

_fold loop re-runs buildLocalState (whole-vault re-read) per fold → fileReads ≈ folds·(F+1), superlinear in C·F_

| variant | fileReads | readsPerFold | dagLeaves | dagMergeBase | sha256 | foldRoundMs | heapMB |
|---|--:|--:|--:|--:|--:|--:|--:|
| wide-concurrency C=3 (bg F=200) | 604 | 302 | 279 | 3 | 1010 | 861.7 | 33.9 |
| wide-concurrency C=5 (bg F=200) | 1006 | 251.5 | 741 | 5 | 1414 | 949.3 | 30.1 |
| wide-concurrency C=10 (bg F=200) | 2011 | 223.4 | 1191 | 10 | 2424 | 1365.8 | 20.1 |

## B8

_normal file ≈ O(L)_

| variant | conflicts | mergeMs |
|---|--:|--:|
| big-file 64KB unique | 4 | 11.6 |
| big-file 256KB unique | 14 | 61.3 |
| big-file 1024KB unique | 53 | 225.6 |
| low-unique 1000 lines | 0 | 58.0 |
| low-unique 4000 lines | 0 | 2381.3 |
| low-unique 8000 lines | 0 | 6720.7 |

## B9

_fixed one-time cost_

| variant | deriveMs | encryptOpMs | encryptBlobMs | blindHashMs | sha256Ms |
|---|--:|--:|--:|--:|--:|
| PBKDF2 derive (one-time) | 77.6 |  |  |  |  |
| AES-GCM per op |  | 0.3 |  |  |  |
| blob 64KB |  |  | 0.6 | 0.1 | 0.3 |
| blob 1024KB |  |  | 8.9 | 0.6 | 3.1 |
| blob 5120KB |  |  | 20.3 | 0.3 | 8.0 |

