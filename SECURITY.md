# Security Policy

## Report a vulnerability

Do not publish an exploitable vulnerability, credential, private endpoint, or personal data in a
public issue. Use the repository's private vulnerability reporting feature when it is available. If
private reporting is not configured, contact the repository owner through the security contact shown
on the GitHub repository page before sharing technical details.

Include the affected registry entry and pinned commit, impact, reproduction conditions, and a safe
way to validate the fix. Registry maintainers may temporarily remove or disable an entry while a
report is investigated.

## Scope

This policy covers the registry validator, contribution automation, and metadata in this repository.
Each external plugin is maintained and released by its author. Report a plugin implementation flaw
to the author's security channel as well as notifying this registry when users may be exposed.

Never include live credentials in a report. Revoke and rotate any credential that may have been
exposed.
