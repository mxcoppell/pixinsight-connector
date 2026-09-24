// PixInsight MCP Watcher Script
// Runs inside PixInsight's PJSR engine (ECMAScript 5)
// One watcher per target folder and machine: the connector writes this script into the target
// (<target>/agentic/watcher/<version>/<machine-id>/watcher.js) with that target's bridge dir baked in,
// and the watcher serves only that dir. Its commands, results, quarantine, heartbeat, launch tickets,
// last-stop and shutdown all live there; nothing is read or written anywhere else.

// Without this, "Execute Script File" (-x=auto) defaults to the legacy
// SpiderMonkey engine, which PixInsight 1.9.4 no longer ships on arm64.
#engine v8

// ============================================================================
// ImageSolver library (V8 build, PixInsight 1.9.5). #include is a compile-time
// directive, so eval'd run_script snippets cannot load it themselves; loading
// it here makes `ImageSolver` available to them. The old AdP/ImageSolver.js is
// not V8-compatible and must not be included.
// ============================================================================
#define SETTINGS_MODULE "MCPSolver"
#define USE_SOLVER_LIBRARY
#include "@@IMAGESOLVER@@"

// ============================================================================
// Configuration
// ============================================================================

// This watcher's bridge dir, <target>/agentic/bridge/<machine-id>, baked in by the connector when it
// wrote this script (a JSON string literal, forward slashes; it may contain spaces).
var BRIDGE_DIR = @@BRIDGEDIR@@;
var COMMANDS_DIR = BRIDGE_DIR + "/commands";
var RESULTS_DIR = BRIDGE_DIR + "/results";
var QUARANTINE_DIR = BRIDGE_DIR + "/quarantine";
var POLL_INTERVAL_MS = 1000;
var WATCHER_VERSION = "0.7.0";
// Written once at start-up, before the first heartbeat: which watcher and which PixInsight this is.
// The connector puts it in its call log (a "watcher start" event) for debugging.
var WATCHER_INFO_FILE = BRIDGE_DIR + "/watcher.json";
// Why the last watcher of this dir stopped ("<reason> | <ms>"), and the file that asks it to stop.
var LAST_STOP_FILE = BRIDGE_DIR + "/last-stop";
var SHUTDOWN_FILE = BRIDGE_DIR + "/shutdown";

// While any script runs, PixInsight greys out view interaction (right-click,
// STF), and a script's Timers/dialogs die when it returns, so a resident
// watcher cannot be non-modal. Instead the bridge launches the watcher on
// demand (PixInsight -x=) and it exits after this long with no commands.
// 0 = stay resident (a manual launch from the Script menu). The connector writes
// one linger ticket per launch into LAUNCHES_DIR; each watcher consumes one at
// startup (mcpTakeLaunchTicket), so a second -x that PixInsight queued until the
// first watcher exited still finds its own and exits on idle too. A watcher that
// finds no fresh ticket was started by hand and stays resident.
var IDLE_EXIT_MS = 0;
var LAUNCHES_DIR = BRIDGE_DIR + "/launches";
// A ticket older than this is ignored and removed. It must outlive the time PixInsight can hold a
// queued launch, which is as long as whatever script is running ahead of it (a long user script
// such as WBPP can run for hours). The connector removes every ticket when it starts a fresh
// PixInsight process, and those written before the running process started, so a spare ticket can
// only outlive its use within one PixInsight session.
var LAUNCH_TICKET_TTL_MS = 24 * 60 * 60 * 1000;
// An unreadable ticket whose name says it was written this recently may still be being written by
// another launch: skip it rather than delete it.
var LAUNCH_TICKET_WRITE_GRACE_MS = 60 * 1000;

// Liveness marker for on-demand launching. "starting <ms>" is written once at
// startup; "idle <ms>" is refreshed while polling; "busy <tool> <ms>" is written
// before a command starts (a running command blocks the loop, so a stale "busy"
// still means alive).
var HEARTBEAT_FILE = BRIDGE_DIR + "/heartbeat";
var HEARTBEAT_TMP = HEARTBEAT_FILE + ".tmp";
// Whether File.move can replace the heartbeat in one step on this system (see writeHeartbeat).
var MCP_ATOMIC_BEAT = true;

// Stale-command guard. A command file is only meant to run while its sender is still waiting for
// it. The bridge writes a command and then launches this watcher on demand, so a legitimate command
// can predate the watcher's start by the time a wait on another connector's PixInsight start, a
// PixInsight autostart and up to three watcher launches take (4 s + 90 s + 90 s + 3 x 30 s, about
// 4.6 minutes); older than MAX_PRESTART_AGE_MS before
// the start, it was left behind by a sender that is gone. No sender waits longer than its send timeout (20 minutes), so a command older than
// MAX_COMMAND_AGE_MS is refused even if it was queued while this watcher was running. A command with
// no timestamp is refused outright. Refused files are moved to QUARANTINE_DIR, never run, and answered with an error result in case anyone is still waiting. The bridge quarantines orphans
// before launching a watcher too; this is the independent second line of defence (and the only one
// for a watcher started by hand from the Script menu).
var MAX_PRESTART_AGE_MS = 5 * 60 * 1000;
var MAX_COMMAND_AGE_MS = 30 * 60 * 1000;
var WATCHER_START_MS = 0;
// Command files this watcher refused but could neither move nor delete (a locked file on Windows).
// They are skipped from then on, so one stuck file cannot be refused on every loop, keep the watcher
// from ever idling out, or starve the commands sorted after it. Keyed by file name (mcpRefusedKey):
// command ids are random UUIDs, so a name never aliases, whichever spelling of the dir listed it.
var MCP_REFUSED = {};

// Writing in place truncates first, so a reader can see an empty file. Write a temp file and move it
// over the old beat instead. If File.move cannot replace an existing file here (it throws, or leaves
// the temp file behind), write in place for the rest of this run; the bridge re-reads an empty or
// unparseable beat before trusting it, so the fallback stays safe.
function writeHeartbeat(state) {
   var text = state + " " + Date.now();
   if (MCP_ATOMIC_BEAT) {
      var moved = false;
      try {
         File.writeTextFile(HEARTBEAT_TMP, text);
         File.move(HEARTBEAT_TMP, HEARTBEAT_FILE);
         moved = !File.exists(HEARTBEAT_TMP);
      } catch (e) {}
      if (moved) return;
      MCP_ATOMIC_BEAT = false;
      try { if (File.exists(HEARTBEAT_TMP)) File.remove(HEARTBEAT_TMP); } catch (e) {}
   }
   try { File.writeTextFile(HEARTBEAT_FILE, text); } catch (e) {}
}

// This PixInsight's version, formatted as PixInsight's own scripts do (AdP/WCSmetadata.jsh):
// "1.9.3", "1.9.3-2" (revision), "1.9.3 RC1" / "1.9.3 beta 4", "LE 1.9.3". null if it cannot be read.
function mcpPixInsightVersion() {
   try {
      var v = (CoreApplication.versionLE ? "LE " : "") + CoreApplication.versionMajor + "." +
         CoreApplication.versionMinor + "." + CoreApplication.versionRelease;
      if (CoreApplication.versionRevision) v += "-" + CoreApplication.versionRevision;
      if (CoreApplication.versionBeta) v += (CoreApplication.versionBeta < 0 ? " RC" : " beta ") + Math.abs(CoreApplication.versionBeta);
      return v;
   } catch (e) {
      return null;
   }
}

// The start-up record. Written in place: a reader that catches it half-written just skips it.
function mcpWriteWatcherInfo(startedAt) {
   try {
      File.writeTextFile(WATCHER_INFO_FILE, JSON.stringify({
         watcherVersion: WATCHER_VERSION,
         pixinsightVersion: mcpPixInsightVersion(),
         startedAt: startedAt
      }));
   } catch (e) {}
}

// Takes this launch's linger: the oldest fresh ticket in LAUNCHES_DIR (removed so the next watcher
// takes the next one). Expired or unreadable tickets are removed. 0 means no ticket: resident.
function mcpTakeLaunchTicket(nowMs) {
   var files = listJsonFiles(LAUNCHES_DIR + "/*.json");
   files.sort();
   var linger = 0;
   for (var i = 0; i < files.length; ++i) {
      var t = null;
      try { t = JSON.parse(readTextFile(files[i])); } catch (e) { t = null; }
      var valid = t !== null && typeof t === "object" && typeof t.at === "number" && typeof t.lingerMs === "number" && t.lingerMs > 0;
      if (!valid) {
         var name = files[i].substring(files[i].lastIndexOf("/") + 1);
         var namedAt = parseInt(name.split("-")[0], 10);
         if (!isNaN(namedAt) && nowMs - namedAt < LAUNCH_TICKET_WRITE_GRACE_MS) continue;
      }
      var fresh = valid && nowMs - t.at <= LAUNCH_TICKET_TTL_MS;
      if (fresh && linger > 0) continue; // another launch's ticket: leave it for its watcher
      if (fresh) linger = t.lingerMs;
      try { File.remove(files[i]); } catch (e) {}
   }
   return linger;
}

// ============================================================================
// File Helpers (PJSR File API)
// ============================================================================

function readTextFile(path) {
   var lines = File.readLines(path);
   return lines.join("\n");
}

function writeTextFile(path, text) {
   File.writeTextFile(path, text);
}

function deleteFile(path) {
   if (File.exists(path)) {
      File.remove(path);
   }
}

function ensureDirectory(path) {
   if (!File.directoryExists(path)) {
      File.createDirectory(path, true);
   }
}

function listJsonFiles(dirPattern) {
   try {
      return File.searchDirectory(dirPattern);
   } catch (e) {
      return [];
   }
}

function getTimestamp() {
   var d = new Date();
   return d.toISOString();
}

// ============================================================================
// Command Handlers
// ============================================================================

function handleListOpenImages(command) {
   var windows = ImageWindow.windows;
   var images = [];
   for (var i = 0; i < windows.length; ++i) {
      var w = windows[i];
      var v = w.mainView;
      var img = v.image;
      images.push({
         id: v.id,
         filePath: w.filePath || null,
         width: img.width,
         height: img.height,
         channels: img.numberOfChannels,
         isColor: img.isColor,
         bitDepth: img.bitsPerSample
      });
   }
   return {
      status: "success",
      outputs: { images: images },
      message: "Found " + images.length + " open image(s)"
   };
}

// Pipeline snippets yield with the bare global processEvents(), which never
// reacts to Pause/Abort, and the global itself is read-only on this engine.
// So each snippet runs inside a function whose `processEvents` parameter
// shadows the global with a version that throws once an abort is pending.
// run_script turns the throw into an error result and the main loop then sees
// console.abortRequested and stops the watcher.
function mcpAbortableProcessEvents() {
   CoreApplication.processEvents();
   if (console.abortRequested) {
      throw new Error("MCP_ABORTED: Pause/Abort was pressed");
   }
   // PixInsight greys the button after every process, including inside one snippet.
   if (!console.abortEnabled) console.abortEnabled = true;
}

function mcpRunSnippet(processEvents, __mcpCode) {
   return eval(__mcpCode);
}

// Error and warning lines from a Process Console log. A process whose executeOn()
// returns false only says why here, so every result carries these.
function mcpConsoleErrors(logText) {
   var lines = String(logText).split("\n");
   var found = [];
   for (var i = 0; i < lines.length; ++i) {
      var line = lines[i].replace(/^\[[^\]]*\]\s*/, "").replace(/\x1b\[[0-9;]*m/g, "").replace(/<[^>]*>/g, "").trim();
      if (/^\*{2,3}\s*(Error|Warning)/i.test(line))
         found.push(line.substring(0, 300));
   }
   return found.slice(-6);
}

function handleRunScript(command) {
   var code = command.parameters.code;
   var result;
   var failure = null;
   console.beginLog();
   try {
      result = mcpRunSnippet(mcpAbortableProcessEvents, code);
   } catch (e) {
      failure = e;
   }
   var consoleErrors = mcpConsoleErrors(console.endLog());
   if (failure) {
      throw new Error("Script error: " + failure.message +
         (consoleErrors.length ? " | Console: " + consoleErrors.join(" ; ") : ""));
   }
   return {
      status: "success",
      outputs: {
         consoleOutput: String(result !== undefined ? result : "Script executed."),
         consoleErrors: consoleErrors
      },
      message: "Script executed successfully"
   };
}

// ============================================================================
// Command Router
// ============================================================================

function dispatchCommand(command) {
   var tool = command.tool;
   // The connector sends only these two; every tool is a run_script snippet. Anything else is
   // answered with an error result rather than run.
   if (tool === "run_script") return handleRunScript(command);
   if (tool === "list_open_images") return handleListOpenImages(command);
   throw new Error("Unknown command: \"" + tool + "\". This watcher runs only run_script and list_open_images.");
}

// ============================================================================
// Stale-command guard (see MAX_PRESTART_AGE_MS above)
// ============================================================================

// Why `command` must not run, or null if it may. Pure, so it can be tested outside PixInsight.
function mcpStaleCommandReason(command, watcherStartMs, nowMs) {
   if (command === null || typeof command !== "object" || Object.prototype.toString.call(command) === "[object Array]") {
      return "it is not a command object";
   }
   var written = Date.parse(command.timestamp);
   if (isNaN(written)) {
      return "it has no valid timestamp";
   }
   if (written < watcherStartMs - MAX_PRESTART_AGE_MS) {
      return "it was written " + Math.round((watcherStartMs - written) / 1000) + " s before this watcher started";
   }
   if (nowMs - written > MAX_COMMAND_AGE_MS) {
      return "it is " + Math.round((nowMs - written) / 1000) + " s old";
   }
   return null;
}

function mcpRefusedKey(filePath) {
   return filePath.substring(filePath.lastIndexOf("/") + 1);
}

function mcpQuarantineCommand(filePath) {
   try {
      ensureDirectory(QUARANTINE_DIR);
      var name = filePath.substring(filePath.lastIndexOf("/") + 1);
      File.move(filePath, QUARANTINE_DIR + "/" + name);
   } catch (e) {}
   // A move that threw, or silently did nothing: delete it instead.
   if (File.exists(filePath)) {
      try { File.remove(filePath); } catch (e) {}
   }
   if (File.exists(filePath)) {
      MCP_REFUSED[mcpRefusedKey(filePath)] = true;
   }
}

// Claims a command before running it by renaming <id>.json to <id>.running, so no other watcher (for
// example a second one PixInsight started later) can pick it up again. If the rename fails, the file
// is remembered in MCP_REFUSED so at least this watcher never runs it twice. Returns the path to
// delete once the command is done.
function mcpClaimCommand(filePath) {
   var claimed = filePath.replace(/\.json$/, ".running");
   try { File.move(filePath, claimed); } catch (e) {}
   if (!File.exists(filePath) && File.exists(claimed)) return claimed;
   MCP_REFUSED[mcpRefusedKey(filePath)] = true;
   return filePath;
}

// Command files waiting to run, sorted, minus any this watcher refused but could not remove. A bridge
// dir that is missing (the target deleted, a volume unmounted) simply has none.
function mcpPendingCommandFiles() {
   var all = listJsonFiles(COMMANDS_DIR + "/*.json");
   var files = [];
   for (var i = 0; i < all.length; ++i) {
      if (!MCP_REFUSED[mcpRefusedKey(all[i])]) files.push(all[i]);
   }
   files.sort();
   return files;
}

// Whether a command is waiting (the idle-exit last look).
function mcpHasPendingCommand() {
   return mcpPendingCommandFiles().length > 0;
}

// ============================================================================
// Main Polling Loop
// ============================================================================

function processNextCommand() {
   // One command per call, taken by sorted file name; ids are random UUIDs, so this is a stable
   // order, not arrival order.
   var pending = mcpPendingCommandFiles();
   if (pending.length === 0) {
      return false;
   }
   var resultsDir = RESULTS_DIR;
   var filePath = pending[0];
   var commandJson, command;

   try {
      commandJson = readTextFile(filePath);
      command = JSON.parse(commandJson);
   } catch (e) {
      console.criticalln("[MCP Watcher] Failed to parse command file: " + filePath + " - " + e.message);
      mcpQuarantineCommand(filePath);
      return true;
   }

   var staleReason = mcpStaleCommandReason(command, WATCHER_START_MS, Date.now());
   if (staleReason) {
      var isObject = command !== null && typeof command === "object";
      console.warningln("[MCP Watcher] Refused command " + filePath + (isObject ? " (" + command.tool + ")" : "") +
         ": " + staleReason + ". Moved to " + QUARANTINE_DIR + ".");
      if (isObject && command.id) {
         try {
            ensureDirectory(resultsDir);
            writeTextFile(resultsDir + "/" + command.id + ".json", JSON.stringify({
               id: command.id,
               timestamp: getTimestamp(),
               status: "error",
               process: command.process,
               duration_ms: 0,
               error: { message: "Refused stale command: " + staleReason + ". It was not run.", type: "StaleCommand", stack: "" }
            }));
         } catch (e) {}
      }
      mcpQuarantineCommand(filePath);
      return true;
   }

   var claimedPath = mcpClaimCommand(filePath);
   var startTime = Date.now();
   var resultObj;
   writeHeartbeat("busy " + command.tool);

   try {
      console.writeln("[MCP Watcher] Executing: " + command.tool + " (id: " + command.id + ")");
      var handlerResult = dispatchCommand(command);
      resultObj = {
         id: command.id,
         timestamp: getTimestamp(),
         status: handlerResult.status,
         process: command.process,
         duration_ms: Date.now() - startTime,
         outputs: handlerResult.outputs || {},
         message: handlerResult.message || ""
      };
   } catch (e) {
      console.criticalln("[MCP Watcher] Error executing " + command.tool + ": " + e.message);
      resultObj = {
         id: command.id,
         timestamp: getTimestamp(),
         status: "error",
         process: command.process,
         duration_ms: Date.now() - startTime,
         error: {
            message: e.message,
            type: e.name || "Error",
            stack: e.stack || ""
         }
      };
   }

   var resultPath = resultsDir + "/" + command.id + ".json";
   try {
      ensureDirectory(resultsDir);
      writeTextFile(resultPath, JSON.stringify(resultObj));
      console.writeln("[MCP Watcher] Result written: " + resultObj.status +
         " (" + resultObj.duration_ms + "ms)");
   } catch (e) {
      console.criticalln("[MCP Watcher] Failed to write result: " + e.message);
   }

   // Delete the claimed command file (remembered and skipped if it cannot be deleted).
   try { deleteFile(claimedPath); } catch (e) {}
   if (File.exists(claimedPath)) MCP_REFUSED[mcpRefusedKey(claimedPath)] = true;

   return true;
}

function runWatcher() {
   WATCHER_START_MS = Date.now();
   // The connector creates the bridge dir before launching; a watcher started by hand creates it here.
   ensureDirectory(BRIDGE_DIR);
   IDLE_EXIT_MS = mcpTakeLaunchTicket(Date.now());
   mcpWriteWatcherInfo(WATCHER_START_MS);
   // Tell the bridge we are alive before anything that can stall on the UI (showing the console and
   // the first event pump can take seconds on a first launch). "starting" counts as alive for a
   // bounded grace however old, since nothing can refresh it until the first pump returns; that pump
   // then writes "idle".
   writeHeartbeat("starting");

   console.noteln("===========================================");
   console.noteln("  PixInsight MCP Watcher v" + WATCHER_VERSION + " (PixInsight " + mcpPixInsightVersion() + ")");
   console.noteln("  Bridge: " + BRIDGE_DIR);
   console.noteln("  Polling every " + POLL_INTERVAL_MS + "ms");
   console.noteln("===========================================");

   if (IDLE_EXIT_MS > 0) {
      console.noteln("  Exits after " + (IDLE_EXIT_MS / 1000) + "s with no commands");
   } else {
      console.noteln("  Stays resident until Pause/Abort or the shutdown file");
   }

   var commandCount = 0;
   var lastActivity = Date.now();
   var lastBeat = 0;
   var stopReason = "";

   console.show();

   // Latching: once any check sees a stop condition every later check returns
   // true, so a `break` out of an inner loop can no longer swallow the signal.
   function shouldShutdown() {
      if (stopReason) return true;
      if (console.abortRequested) {
         stopReason = "abort requested";
         return true;
      }
      if (File.exists(SHUTDOWN_FILE)) {
         try { File.remove(SHUTDOWN_FILE); } catch(e) {}
         stopReason = "shutdown file";
         return true;
      }
      if (IDLE_EXIT_MS > 0 && Date.now() - lastActivity > IDLE_EXIT_MS) {
         // Last look before leaving: don't strand a command that just arrived.
         if (mcpHasPendingCommand()) {
            lastActivity = Date.now();
            return false;
         }
         stopReason = "idle for " + (IDLE_EXIT_MS / 1000) + "s";
         return true;
      }
      return false;
   }

   // PixInsight resets console.abortEnabled to false every time a process
   // finishes, so it is re-armed on every pump, not once at startup.
   function pump() {
      if (!console.abortEnabled) console.abortEnabled = true;
      CoreApplication.processEvents();
      var now = Date.now();
      if (now - lastBeat > 500) {
         writeHeartbeat("idle");
         lastBeat = now;
      }
   }

   // The idle clock starts only once start-up UI work is done. Before this, a first launch whose
   // console/UI start-up stalled for longer than IDLE_EXIT_MS wrote its first heartbeat
   // and idled out in the same loop iteration, so the bridge never saw it alive (e2e: "Watcher did
   // not start within 30s" while last-stop said "idle for 8s").
   pump();
   lastActivity = Date.now();

   // Main loop — pump() keeps PixInsight UI responsive and the abort button armed
   for (;;) {
      pump();

      if (shouldShutdown()) break;

      var processed = processNextCommand();
      if (processed) {
         commandCount++;
         lastActivity = Date.now();
         // Yield heavily after command execution so UI can catch up
         for (var y = 0; y < 20; ++y) {
            pump();
            System.msleep(20);
            if (shouldShutdown()) break;
         }
      } else {
         // No commands — short sleeps, ~500ms idle cycle (25 x 20ms)
         for (var i = 0; i < 25; ++i) {
            System.msleep(20);
            pump();
            if (shouldShutdown()) break;
         }
      }
   }

   console.abortEnabled = false;
   // last-stop is written BEFORE the heartbeat is removed, so "heartbeat gone" implies a reason is readable
   try { File.writeTextFile(LAST_STOP_FILE, stopReason + " | " + Date.now()); } catch (e) {}
   try { File.remove(HEARTBEAT_FILE); } catch (e) {}
   try { if (File.exists(HEARTBEAT_TMP)) File.remove(HEARTBEAT_TMP); } catch (e) {}
   console.warningln("[MCP Watcher] Stopping: " + stopReason + ".");
   console.noteln("[MCP Watcher] Stopped. Processed " + commandCount + " command(s).");
}

// ============================================================================
// Entry Point
// ============================================================================

runWatcher();
