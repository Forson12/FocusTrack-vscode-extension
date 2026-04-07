# Changelog

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