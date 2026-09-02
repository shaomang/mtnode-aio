# Task graph

![Task graph](img/task-flow.svg)

Every task contains:

1. **Start** (created automatically; not in the add menu)
2. Steps, sub-tasks, judges (yes/no)
3. **Success end / fail end**

▶ advances along control wires from start. Reaching success completes the task; fail end or a stuck graph fails. Parent tiles mirror sub-tasks.

The judge node asks a text model for YES/NO from the goal and existing results. A text provider with an API Key is required.
