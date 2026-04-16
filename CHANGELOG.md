# Changelog

## 0.2.0
- added richer IDE activity tracking
- added support for debug session events:
  - `debug_start`
  - `debug_end`
- added support for task execution events:
  - `task_run`
- added support for terminal activity events:
  - `terminal_open`
- added support for file system activity events:
  - `file_rename`
  - `file_delete`
- improved extension usefulness for richer FocusTrack IDE context
- prepared updated extension build for redeployment

## 0.0.1
- initial release of the FocusTrack VS Code extension
- added local connection support for communicating with the FocusTrack desktop app
- added token-based authentication using a token generated from the app
- implemented IDE activity event capture and forwarding
- added support for the following IDE event actions:
  - `workspace_active`
  - `file_open`
  - `file_switch`
  - `edit`
  - `save`
- prepared extension packaging and repository structure for distribution