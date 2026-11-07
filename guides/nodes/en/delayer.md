# Delayer

![diagram](img/delayer.svg)

Wait the configured duration (day / hour / min) after a pulse, then continue downstream.

## Ports
- **In**: control
- **Out**: control

## Settings
- In the settings window opened by **⚙ Settings** in the node header; **Delay (day / hour / min)**: default 1 minute
- The node shows only a one-line summary

## Usage
- **▶** starts one delay immediately and enables the wired targets, without waiting for an upstream pulse
