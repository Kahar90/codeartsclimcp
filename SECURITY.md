# Security

Please report vulnerabilities privately through GitHub's
[security advisory form](https://github.com/Kahar90/codeartsclimcp/security/advisories/new),
not in a public issue.

What we treat as security issues:
- credentials (`CODEARTS_CLI_AK`, `CODEARTS_CLI_SK`, `MAAS_API_KEY`) printed, logged or written to disk
  outside the user's protected store;
- the dashboard (port 4777) reachable from another machine, or accepting requests with a foreign Host
  or Origin;
- a lane reading or writing outside its repo without being flagged.

Only the latest release is supported.
