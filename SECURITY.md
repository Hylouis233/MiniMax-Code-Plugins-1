# Security Policy

## Report a vulnerability

Do not publish an exploitable vulnerability, credential, private endpoint, or personal data in a
public issue. Use the repository's private vulnerability reporting feature when it is available. If
private reporting is not configured, contact the repository owner through the security contact shown
on the GitHub repository page before sharing technical details.

Include the affected `plugins/<owner>/<plugin>` path, commit, impact, reproduction conditions, and a
safe way to validate the fix. Maintainers may quarantine or remove a Plugin while a report is
investigated.

## Scope

This policy covers hosted Plugins, validation tooling, contribution automation, and repository
metadata. Notify repository maintainers when a Plugin implementation may expose users.

Never include live credentials in a report. Revoke and rotate any credential that may have been
exposed.
