# variant: default, trajectories 300-800

| large results | compressed | tokens | sent | saved | edit-miss (of edited) | quote-miss | ref-miss | objective | views | mean ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 3296 | 2799 | 11637.1k | 2444.6k | 79.0% | 2/26 (7.7%) | 9 (0.3%) | 74 (2.2%) | 37.7 | signals:1733, testlog:463, full:497, relevant:277, outline:109, tree:113, focus:79, log:6, matches:3, head_tail:16 | 402 |

| kind | n | saved | edit-miss | ref-miss |
|---|---|---|---|---|
| command | 2402 | 88.4% | 0.0% | 1.8% |
| data | 10 | 19.3% | 0.0% | 0.0% |
| code | 535 | 30.9% | 8.0% | 2.8% |
| prose | 165 | 58.0% | 0.0% | 0.6% |
| listing | 184 | 47.0% | 0.0% | 7.6% |
