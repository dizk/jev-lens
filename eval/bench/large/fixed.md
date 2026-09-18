# variant: default, trajectories 300-800

| large results | compressed | tokens | sent | saved | edit-miss (of edited) | quote-miss | ref-miss | objective | views | mean ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 3344 | 3031 | 11710.8k | 2182.7k | 81.4% | 7/42 (16.7%) | 12 (0.4%) | 87 (2.6%) | -5.3 | signals:1708, testlog:486, full:313, relevant:514, tree:113, focus:83, log:7, outline:104, matches:3, head_tail:13 | 412 |

| kind | n | saved | edit-miss | ref-miss |
|---|---|---|---|---|
| command | 2402 | 88.3% | 0.0% | 2.0% |
| code | 583 | 52.3% | 17.1% | 3.9% |
| prose | 165 | 58.4% | 0.0% | 0.6% |
| data | 10 | 19.3% | 0.0% | 0.0% |
| listing | 184 | 47.0% | 0.0% | 7.6% |
