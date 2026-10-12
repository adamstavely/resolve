# Self-hosted fonts

Geist and Geist Mono (variable, weights 100–900), latin and latin-ext subsets only.
Extracted byte-for-byte from the woff2 assets packed into `design/reference/resolve-console.html`
on 2026-10-12, so production loads no fonts from public hosts.

Geist is published by Vercel under the SIL Open Font License 1.1, which permits bundling and
self-hosting. Before release: add the upstream `OFL.txt` alongside these files and record font
approval (plan 06 requires "approved fonts"). Other subsets (cyrillic, vietnamese) fall back to
`system-ui` until a supported-locale decision requires them.
