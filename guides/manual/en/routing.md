# Gate, split, mutex

![Gate](img/routing.svg)

Control nodes share a **gold outer ring**; inner color still shows the kind.

| Node | Role |
| --- | --- |
| **Gate** | AND: as many pulses as **configured** inputs (unwired ports still block) |
| **Splitter** | One in, many out |
| **Sequencer** | Fire downstream in order |
| **Counter** | Release after N pulses |
| **Mutex** | Pick one lane (first / port order / random) |
| **Wait file** | Continue when a file appears or changes |

▶ is often a trial pulse; see each **Node guide**.
