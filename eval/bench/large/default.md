# variant: default, trajectories 300-800

| large results | compressed | tokens | sent | saved | edit-miss (of edited) | quote-miss | ref-miss | objective | views | mean ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 3350 | 3055 | 11720.8k | 2144.1k | 81.7% | 8/46 (17.4%) | 12 (0.4%) | 86 (2.6%) | -8.5 | signals:1720, testlog:478, full:295, relevant:520, outline:124, tree:112, focus:80, log:5, matches:3, head_tail:13 | 394 |

| kind | n | saved | edit-miss | ref-miss |
|---|---|---|---|---|
| command | 2402 | 88.4% | 0.0% | 1.9% |
| code | 588 | 54.9% | 17.8% | 4.3% |
| prose | 166 | 59.0% | 0.0% | 0.6% |
| data | 10 | 19.3% | 0.0% | 0.0% |
| listing | 184 | 46.1% | 0.0% | 7.6% |
