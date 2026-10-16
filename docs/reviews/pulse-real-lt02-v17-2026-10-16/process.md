# LT02 v17 逐请求过程

仅含请求元数据和工具名称，不包含推理正文、凭据或配置内容。

| 次数 | 阶段 | 类型 | HTTP | 耗时 ms | 输入 / 输出 token | 工具 |
|---:|---|---|---:|---:|---:|---|
| 1 | — | plan | 200 | 8140 | 3433 / 1508 | — |
| 2 | s1-resume-module | work | 200 | 1489 | 9702 / 124 | fs.list, fs.list |
| 3 | s1-resume-module | work | 200 | 1190 | 10417 / 115 | fs.read, fs.read |
| 4 | s1-resume-module | work | 200 | 1308 | 12844 / 196 | fs.read, fs.read |
| 5 | s1-resume-module | work | 200 | 1520 | 14835 / 215 | fs.read, fs.search |
| 6 | s1-resume-module | work | 200 | 8763 | 16838 / 1440 | fs.read, fs.read |
| 7 | s1-resume-module | work | 200 | 18392 | 18828 / 3704 | fs.write |
| 8 | s1-resume-module | work | 200 | 9856 | 22077 / 2220 | fs.read, fs.write |
| 9 | s1-resume-module | work | 200 | 1826 | 27187 / 268 | shell.exec, shell.exec |
| 10 | s1-resume-module | verify-stage | 200 | 6398 | 23940 / 1000 | — |
| 11 | s2-run-resume | work | 200 | 5532 | 32406 / 878 | fs.read, fs.read |
| 12 | s2-run-resume | work | 200 | 75849 | 34662 / 14978 | fs.apply_patches, fs.read |
| 13 | s2-run-resume | work | 200 | 16241 | 39051 / 2631 | shell.exec, fs.read, fs.read |
| 14 | s2-run-resume | verify-stage | 200 | 17760 | 38277 / 3009 | — |
| 15 | s3-readme | work | 200 | 8622 | 45225 / 1671 | fs.apply_patch |
| 16 | s3-readme | work | 200 | 1591 | 48221 / 174 | fs.read, fs.search |
| 17 | s3-readme | work | 200 | 5529 | 51242 / 879 | — |
| 18 | s3-readme | verify-stage | 200 | 2897 | 48726 / 347 | — |
| 19 | s4-verify | work | 200 | 9880 | 56425 / 1487 | fs.list, fs.list, fs.read |
| 20 | s4-verify | work | 200 | 10617 | 60254 / 1622 | fs.read, fs.search |
| 21 | s4-verify | work | 200 | 57001 | 64138 / 8965 | fs.read |
| 22 | s4-verify | compaction | 200 | 13726 | 43668 / 2157 | fs.list, fs.read |
| 23 | s4-verify | work | 200 | 18535 | 39665 / 3009 | evaluation-acceptance.resume, fs.list |
| 24 | s4-verify | work | 200 | 61579 | 42344 / 10907 | fs.read, fs.read |
| 25 | s4-verify | progress-review | 200 | 28782 | 39987 / 4640 | — |
| 26 | s4-verify | work | 200 | 40120 | 48809 / 7800 | fs.write |
| 27 | s4-verify | work | 200 | 3633 | 54311 / 461 | fs.read |
| 28 | s4-verify | work | 200 | 38573 | 57924 / 7858 | fs.apply_patches |
| 29 | s4-verify | compaction | 200 | 36394 | 34461 / 7048 | fs.write |
| 30 | s4-verify | work | 200 | 13269 | 58132 / 1840 | shell.exec |
