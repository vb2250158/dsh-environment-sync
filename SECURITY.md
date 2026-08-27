# Security

## Private data

Do not commit DSH settings, credentials, plugin installation manifests, logs, sessions, attachments, or machine-specific paths to this public repository.

The private configuration repository must be outside this source tree. Credentials are encrypted with AES-256-GCM and a scrypt-derived key. The synchronization key is stored in `$DSH_HOME/private-sync.key` or supplied through `DSH_PRIVATE_SYNC_KEY`; it must never be committed.

## Plugin installation

Only exact registry versions or GitHub references pinned to a 40-character commit are portable. New computers install recorded plugins through the official `dsh plugin` command.

## Reporting

Report security issues through the repository's private security advisory channel.
