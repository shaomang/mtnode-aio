# Judge

![diagram](img/judge.svg)

A text model decides whether the goal is met: yes leaves by the top port, no by the bottom one.

## Ports
- **In**: control pulse
- **Out**: top = **yes**, bottom = **no**

## Usage
- The **Criteria** text box on the node may stay empty; then the owning task's goal is used
- Text wired into the node is handed to the model as existing results

## Notes
- With no text provider that has an API key, the judge does not run and the task goes to “Needs attention”.
