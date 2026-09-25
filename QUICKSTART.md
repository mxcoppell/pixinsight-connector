# Quick start

From a new computer to a processed LRGB image: set up once, then one prompt per target.

## 1. Install the astro side

| What | Why | Where |
|---|---|---|
| PixInsight 1.9.5+ | the image processor | pixinsight.com (license required) |
| Gaia DR3/SP database | plate solving, SPCC colour calibration | PixInsight account, Software Distribution |
| MARS database | MultiscaleGradientCorrection | PixInsight account, Software Distribution |
| RC-Astro BlurXTerminator, NoiseXTerminator | deconvolution, noise reduction (commercial) | rc-astro.com: add their update repository in PixInsight |

In PixInsight, point Gaia and MARS at the downloaded files in each process's preferences.

## 2. Install the agent side

- **Node 22+** from nodejs.org.
- **A coding agent**, any one of: Claude Code, Codex, OpenCode.
- **A model:** start with a Sonnet-class model (Claude Sonnet 5, GPT-6 Sol, Gemini 3.8 Flash). Once a run
  works, try cheaper ones. Prices: [docs/setup.md](docs/setup.md#models).

## 3. Let the agent install the connector and skills

Open the agent in any folder and paste:

```text
Install the PixInsight connector and its companion skills for this harness, following
https://github.com/mxcoppell/pixinsight-connector-skills#install
Register the connector as the MCP server "pixinsight", once only.
Then run "pixinsight-connector doctor" and tell me what it reports.
```

Restart the agent so it loads the new MCP server and skills.

## 4. Prepare a target folder

One folder per target, holding the integrated masters (XISF or FITS; subfolders are fine):

```text
NGC2244/                        <- open the agent here
└── Integration/                <- any name, any depth
    ├── masterLight_L.xisf      <- XISF or FITS (.fit, .fits)
    ├── masterLight_R.xisf
    ├── masterLight_G.xisf
    └── masterLight_B.xisf
```

- Integrated masters only: no subframes, no calibration frames.
- Keep the FITS headers (FILTER, OBJECT, RA/DEC, camera, focal length). The more they say, the fewer questions.
- Your masters are never modified. Everything is written to `agentic/` and `output/` in this folder.

## 5. Start processing

Open the agent **in the target folder** and paste:

```text
Process the LRGB masters in this folder with the basic LRGB skill from pixinsight-connector-skills.
Run preflight and target intake first. Ask me anything the headers don't answer.
```

## 6. Be ready to answer

Intake asks once, in one message, for whatever the headers leave out. Have ready:

- Camera model (for its QE curve) and filter brand/set.
- Focal length and pixel size, or the pixel scale.
- The target's name or coordinates.

Leave PixInsight alone while the agent works. To stop it, use Pause/Abort in PixInsight's watcher dialog,
then tell the agent whether to continue.

## 7. What to expect

| Model | Cost per run | Speed |
|---|---|---|
| Opus-class | about $5-6 | fast |
| Sonnet-class | about half of Opus | fast |
| Small models (GPT-6 Luna) | about $2 | much slower |

Tens to a hundred PixInsight calls per run. Afterwards the folder looks like this:

```text
NGC2244/
├── Integration/                         <- untouched
├── output/
│   ├── NGC2244_LRGB_basic_linear.xisf   <- the final: 32-bit linear, stars included, auto-STF embedded
│   └── NGC2244_LRGB_basic_report.md     <- each step's numbers and the full call log
└── agentic/                             <- working files, safe to delete after the run
    ├── preflight.json                   <- what your PixInsight has installed
    ├── work/
    │   ├── target-info.md               <- camera, filters, position, pixel scale
    │   └── NGC2244_stage*.xisf          <- intermediate stages
    ├── logs/                            <- every tool call, for issue reports
    ├── scratch/                         <- previews
    └── bridge/                          <- connector to PixInsight messaging
```

The final is **linear**: it looks right under PixInsight's STF auto-stretch, not in an ordinary image viewer.
If something fails, run `pixinsight-connector doctor`, then see [docs/troubleshooting.md](docs/troubleshooting.md).

## 8. Make it yours

The basic skill is a starting point. Your own look, order and values belong in **your own skill repository**:

- **Private** for the technique you keep to yourself, **public** to share it. Copy the basic skill and change it,
  or write one from scratch in the [Agent Skills](https://agentskills.io) format.
- Ask your agent to help: it can read the basic skill, your reports, and run the new skill on your data.
- Published one? Add a row to [COMMUNITY.md](COMMUNITY.md) so others can find it.

## 9. Report what breaks

A tool that fails, refuses, or does something odd is worth an issue:
[open one here](https://github.com/mxcoppell/pixinsight-connector/issues/new/choose). Include the
`pixinsight-connector doctor` output, the model and harness, and the call log from `agentic/logs/`. Runs with
models not yet tested ([docs/setup.md](docs/setup.md#models)) are welcome too, working or not.
