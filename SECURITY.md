# Security

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on this repository
(a private security advisory). Please do not open a public issue for it. Include the connector version
(`pixinsight-connector doctor` prints it), your OS and PixInsight version, and the smallest steps that show the
problem. You will get an answer within a week.

## What the connector can do on your machine

- It starts PixInsight and runs PJSR code there. `run_pjsr` and `run_pjsr_file` run whatever code the
  agent sends, with your privileges: treat an agent that can call them as able to run code.
- It writes only `<target>/agentic/` and `<target>/output/` in the target folder. `export_image` refuses
  any other destination.
- A pack is arbitrary code: only the packs listed in `PIXINSIGHT_CONNECTOR_PACKS` load, and nothing is fetched.
- The call logs in `<target>/agentic/logs/` hold file paths and the code that ran. Check a log before
  sharing it.
