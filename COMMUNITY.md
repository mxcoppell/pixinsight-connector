# Community skills and packs

The connector ships no technique. Technique lives here: skills (markdown that guides an agent) and packs
(code that adds tools), published by whoever wrote them.

| Name | Kind | Author | What it does | Visibility |
|---|---|---|---|---|
| `mxcoppell/pixinsight-connector-skills` | Skills | mxcoppell | Environment preflight (`inspect_environment`), dataset intake, a basic all-linear LRGB flow and troubleshooting; installable as a plugin that also registers this connector | Public |
| `mxcoppell/pixinsight-pack-astro` | Pack | mxcoppell | Folded into the connector in 1.2.0: its stretch, detail, mask, narrowband, star and measurement tools are core tools now, and the values it used as defaults now belong in skills. Do not load it with 1.2.0 or later: it would replace the core tools of the same names | Archived at the 1.2.0 release |

Private entries are listed so you know they exist and what shape a skill or pack can take; you cannot
install them. The maintainer's own processing skills are private and not listed.

## Add yours

Open a PR that adds one row to the table above: the repository (`owner/name`), whether it is a skill or a
pack, who maintains it, one line on what it does, and whether it is public. No connector change is needed.

- **A skill** is markdown the agent reads. Anything that works in your harness is fine; the [Agent Skills](https://agentskills.io)
  format lets one source serve several harnesses.
- **A pack** is an ES module that exports `apiVersion` (`1`), `name`, `version` and `tools`. See
  [CONTRIBUTING.md](CONTRIBUTING.md#developing-a-pack) for the contract and how users load it.

Listing is not an endorsement or a review. A pack is arbitrary code that runs with the user's privileges;
read it before you install it.
