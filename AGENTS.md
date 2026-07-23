# CODEGATE workspace instructions

## Electron application launch

- Whenever launching the user-facing application from `codegate-2026-web`, use real OAuth by setting
  `CODEGATE_AUTH_MODE=cloud`.
- Always set `CODEGATE_OAUTH_REDIRECT_URI=http://127.0.0.1:47821/auth/callback` explicitly for an
  application launch so a conflicting shell environment cannot override the project `.env` value.
- Apply these values to every application entry point, including `pnpm dev`, `pnpm dev:integrated`, and
  `pnpm start`. Do not launch the application with the local authentication bypass unless the user
  explicitly changes this instruction.
- Unit and integration test fixtures may continue to use isolated auth modes or ephemeral callback ports
  when required by the test contract.
