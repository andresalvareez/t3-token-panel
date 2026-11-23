# T3 Token Panel

A custom light/dark theme and conversation cost panel for **T3 Code Beta 0.1.11 on macOS**. It adds collapsible sections for tokens, estimated cost, context usage, provider limits, subagents, context handoffs, and an agent tree.

This repository contains the exact theme and patch sources exported from a working installation on November 23, 2026, including the correction made after the initial 0.1.11 package. It rebuilds the patched application archive from your own compatible T3 installation. The complete T3 application is not included.

The documentation is in English. The exported panel keeps its original Spanish labels, including the theme name **Panel de tokens**, to preserve the verified code and appearance.

## What is included

- A custom theme with dark and light variants.
- A token breakdown: uncached input, cache reads, cache writes, and output.
- Estimated conversation cost, last-turn cost, cache hit rate, and estimated cache savings.
- Context window usage, compaction information, and available provider usage limits.
- A separate subagent usage summary and an expandable agent tree.
- Context handoff information and a rough estimate of summary size and cost.
- Tools to rebuild, verify, install, and restore the patch.

**The theme and code patch work together.** Installing only the JSON theme applies colors and styles; it does not add the cost calculations or server endpoint.

## Compatibility and requirements

- **T3 Code Beta 0.1.11** installed at `/Applications/T3 Code (Beta).app`.
- The exact application build accepted by the installer's SHA-256 checks.
- macOS; the exported build was verified on Apple silicon.
- Python **3.9 or newer** and Node.js **18 or newer**, available in your terminal.
- About **600 MB** of free disk space for rebuilding and keeping the original archive.

The scripts use standard libraries and do not require `npm install`, `pip install`, API keys, or an external pricing service. Windows, Linux, other T3 releases, and other application builds have not been verified. A matching version number alone does not guarantee compatibility: the installer also checks the archive, application metadata, and Electron ASAR integrity setting.

## Installation

### 1. Download the repository

```sh
git clone https://github.com/andresalvareez/t3-token-panel.git
cd t3-token-panel
```

Alternatively, use **Code → Download ZIP**, extract it, and open Terminal in the extracted repository folder. Run the commands below from that folder.

### 2. Check compatibility and prepare the patch

```sh
python3 --version
node --version
python3 -I patch/install.py check
python3 -I patch/prepare.py
```

`check` reads your installed app and reports whether it is the compatible original or already has this panel installed. `prepare.py` extracts two original JavaScript assets, applies the patch, rebuilds a new ASAR archive, checks every packed file, and verifies the complete output hash.

The generated archive is saved as `patch/app.token-panel-0.1.11.asar`. Preparing it does **not** modify the installed application. If the panel is already installed, rebuilding requires the original backup created by the installer.

### 3. Quit T3 and install

Quit T3 completely with **Cmd+Q**, then run this command from a separate **Terminal** window:

```sh
python3 -I patch/install.py apply
```

The installer refuses to replace the archive while T3 is running. It saves the compatible original at:

```text
~/.t3/userdata/backups/token-panel-0.1.11/app.original.asar
```

It verifies the source and staged copy, replaces the archive atomically, and checks the installed hash. Keep the backup if you want to restore the original app later.

### 4. Activate the theme

Open T3 again, then run:

```sh
"$HOME/.t3/bin/t3" theme set "$PWD/theme/token-panel.json" --id token-panel --base-dir "$HOME/.t3"
```

If the T3 CLI is unavailable, copy the theme file manually:

```sh
mkdir -p "$HOME/.t3/userdata/themes"
cp theme/token-panel.json "$HOME/.t3/userdata/themes/token-panel.json"
```

Restart T3 and select **Panel de tokens** in its appearance settings. Choose dark mode for the appearance used by the original installation; the theme also includes a light variant.

### 5. Open the conversation details panel

Open a conversation with recorded token usage and show its details panel. Each supported section can be collapsed. Collapse preferences are saved locally by section, rather than by conversation.

The theme reduces visible detail in shorter windows and hides the token card at window heights of **520 px or less**. If the card is missing, check the theme, installed patch, recorded usage, details panel, and available window height.

## What each cost includes

### Main Tokens / Cost total

The main total sums recorded usage from provider turns in the **currently available history of the selected thread**. It deduplicates turns by ID and skips turns whose `runAttemptId` is `null`.

For each turn, cached input is separated from ordinary input so the same input tokens are not counted twice. The estimate is:

```text
cost = (
    uncached_input_tokens × input_price
  + cache_read_tokens     × cache_read_price
  + cache_write_tokens    × cache_write_price
  + output_tokens         × output_price
) / 1,000,000
```

Prices are in **USD per million tokens**, using the model associated with each turn. The main total is scoped to the selected thread; it is not an aggregate bill for every descendant conversation.

Known usage from incomplete turns can contribute to the total, with a **partial** indicator. Tokens from a model without a known price can still appear in token totals while their cost is omitted and the result is marked partial.

### Last turn and cache savings

The last-turn row shows usage and estimated cost for the last turn with recorded usage. Cache savings compare the cache-read charge with what the same number of tokens would cost as ordinary input. This is a comparison estimate, not an additional credit applied to the displayed cost.

### Subagents

Subagent tokens and cost appear **separately and are not included in the main total above them**. The summary loads up to **12 child threads**. More children, missing history, incomplete usage, or unpriced models can make this summary partial.

### Agent tree

The agent card shows a separate tree/history breakdown from the records and local transcripts the server can read. This view can overlap the main thread's usage, so do not automatically add the entire card to the main total.

Web searches are counted, but their separate service fees are excluded. The view can be partial when transcripts are unavailable, usage is incomplete, or reading limits are reached. The displayed tree is capped at **2,000 nodes**. In this breakdown, one-hour cache writes are approximated at twice the input rate; five-minute writes use the cache-write rate.

### Context handoffs

The handoff section estimates summary tokens as **summary text characters / 4** and applies the destination model's input rate. It is an informational estimate. The UI labels it as included in the total; the code does not add this estimate as a separate charge on top of recorded turn usage. Do not add it again.

### Context, compactions, and limits

These sections report context window usage, released context, and available provider quotas. Their values are not additional charges. A quota percentage is distinct from a monetary cost.

### Accuracy and exclusions

All costs are **estimates in USD**, rather than provider invoices or actual subscription spending. Values are rounded to two decimal places; positive amounts below one cent show `< 0.01 $`.

The **partial** label can mean unloaded history, incomplete token accounting, skipped usage, missing prices, missing transcripts, or a reading budget limit. External fees that are not represented by the recorded tokens—such as search/tool charges and fixed subscription fees—are not included.

## Pricing and model aliases

The embedded price table is dated **2026-11-17**. [prices-reference.json](prices-reference.json) is a readable snapshot with rows in this order:

```text
[model, input, output, cache_read, cache_write]
```

All four rates are USD per million tokens. **Editing this JSON file does not change the running panel's prices.** The runtime table is embedded in `patch/sources/helper.js` as `PRICE_TABLE`.

The panel also reads `settings.usagePriceOverrides` and `settings.usageModelAliases` exposed by T3. Use T3's price controls where your version provides them. A price override for an exact model ID has this shape:

```json
{
  "usagePriceOverrides": {
    "your-model-id": {
      "inputCostPerMillionTokens": 2,
      "outputCostPerMillionTokens": 10,
      "cacheReadCostPerMillionTokens": 0.1,
      "cacheWriteCostPerMillionTokens": 2.5
    }
  }
}
```

This example illustrates the settings fields; it is not a replacement for your complete settings file. If an override omits a cache rate, the panel uses the input rate for that category. No accounts, credentials, or settings from the original installation are needed.

## Restore the original application

Quit T3, then run from Terminal:

```sh
python3 -I patch/install.py restore
```

Select another theme afterward. Restoration requires the verified original backup. T3 updates replace the application archive and remove this patch; this repository does not automatically adapt it to a newer release.

## Troubleshooting

- **Unsupported build or unknown SHA-256:** this installation differs from the verified build. The scripts stop without applying the patch. Porting requires reviewing the new assets and integration points.
- **Python hashing compatibility:** the installer supports Python 3.9 and 3.10 by using a streaming SHA-256 implementation instead of `hashlib.file_digest`.
- **T3 is still running:** quit it fully and rerun `apply` or `restore` in Terminal.
- **Original archive missing:** an already patched installation needs the original backup to rebuild or restore. The repository does not include that archive.
- **No cost, or a partial cost:** check recorded usage, loaded history, the model's price, and any partial indicators. A missing price does not imply zero cost.
- **Theme visible but no extra cards:** activate both the code patch and the theme, restart T3, and open conversation details in a sufficiently tall window.

## Repository layout and adaptation

```text
theme/token-panel.json       Original exported theme
patch/build.mjs             Verified asset hashes and insertion points
patch/sources/helper.js     Cost calculations, prices, subscriptions, and panel UI
patch/sources/agentTree.mjs  Server-side agent/history reader
patch/sources/route.js      Authenticated agent-tree endpoint
patch/sources/compiled-*.js Active-agent count and subscriptions
patch/asar_repack.py        ASAR rebuild and content verification
patch/prepare.py            Extract, build, repack, and verify
patch/install.py            Compatibility checks, installation, and restoration
prices-reference.json       Reference price snapshot
verification.json          Export/rebuild verification report
SHA256SUMS.txt              Checksums of the repository's distributed files
LICENSE                    MIT license with the upstream notice preserved
```

The server endpoint is `/api/tokpanel/agent-tree/<threadId>`. It uses the recipient's local T3 environment and authentication. The patch contains no original conversations, databases, transcripts, account settings, API keys, or caches.

To adapt the code to another T3 build, review the imports and insertion points in `build.mjs`, the server integration, and the new original assets. The build and installer intentionally pin verified input/output hashes. Editing sources requires rebuilding, reviewing the result, and updating those hashes; otherwise the expected-output check will fail.

## Verification

The exported sources rebuilt an archive whose SHA-256 exactly matched the installed, corrected panel:

```text
Original: a505328c7a183f98103867e06ab46a93dd7f8739bc2990b6a73cd93fafd37959
Patched:  4daebdcd79c36607b5cae58070083fed1a7aefe0c8f0fbd4ca4912058835f41c
```

Verification checked **2,780 packed files**: **2,778 unchanged** and **2 replaced**, with **109 unpacked/link entries preserved**, valid integrity metadata, and a valid header round trip. Python/JavaScript syntax and JSON were also checked. The installed application was not modified during export or repository preparation. See [verification.json](verification.json) for details.

On macOS, verify the distributed file checksums from the repository root:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Generated ASAR archives, temporary build files, and Python caches are excluded from Git.

## License

MIT. The upstream T3 Tools Inc. copyright notice is preserved in [LICENSE](LICENSE). This is a custom patch for the specified build, rather than an official T3 release.
