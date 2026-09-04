# Security policy

## Supported versions

Noesis is in public beta. Security fixes are applied to the latest `0.0.x` release.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

Email [s@swarnimw.com](mailto:s@swarnimw.com) with the subject `Noesis security report`. Include the affected version, impact, reproduction steps, and any suggested mitigation. Please remove credentials, private session content, and other secrets from the report.

You will receive an acknowledgement after the report has been reviewed. Please allow time for a fix and coordinated disclosure before publishing details.

## Security model

Noesis is a local agent harness, not a sandbox. It runs with the file-system, terminal, and network access of its process. Workspace-selected skills and MCP servers require explicit workspace trust, but a trusted model may still use the direct file and shell tools available to the process.

Credentials are stored under the configured Noesis home and are not intended to enter prompts, transcripts, or generated artifacts. Reports involving credential exposure, authority bypass, unsafe irreversible effects, or recovery and audit integrity are especially useful.
