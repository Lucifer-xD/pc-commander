<div align="center">

<img src="assets/docs/banner.png" alt="PC Commander" width="100%">

<br>

![Platform](https://img.shields.io/badge/Your%20PC-Windows-0ea5e9?style=flat-square)
![Works with](https://img.shields.io/badge/Works%20with-ChatGPT-6366f1?style=flat-square)
![Setup](https://img.shields.io/badge/Setup-about%2010%20min-22c55e?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-a855f7?style=flat-square)

### Ask ChatGPT to do something on your computer, and it actually does it — after you tap **Approve**.

</div>

---

## 👋 What is this, in plain words?

You know how ChatGPT can *tell* you how to do things on your computer, but can't actually **do** them? This fixes that.

**PC Commander is like a remote control for your PC that ChatGPT can use — except you're always holding the "Approve" button.**

Ask ChatGPT *"is Python installed on my computer?"* and instead of guessing, it checks **your** PC and tells you the real answer. Ask it to *"clean up my Downloads folder"* and it does — right after a little box pops up on your screen and you click **Approve**.

Nothing ever happens on your computer unless **you** allow it.

<div align="center">
<img src="assets/docs/steps.png" alt="Three simple steps: you ask, you approve, you get the answer" width="92%">
</div>

---

## 💡 Things you can ask it

Once it's set up, just chat normally. For example:

- *"Is Python (or Node, or Git) installed on my PC?"*
- *"What's taking up all the space on my hard drive?"*
- *"Clean up my Downloads folder — delete anything older than a month."*
- *"What's my computer's IP address and Windows version?"*
- *"Make a folder on my Desktop called Taxes and move all my PDFs into it."*
- *"Is my laptop running hot? What's using the most memory right now?"*
- *"What's on my screen right now?"* — it can actually **take a screenshot and look**.

It can do basically anything you could type into your PC yourself — you just approve it first.

---

## 🧰 What it can do

PC Commander gives ChatGPT a real toolbox, not just a command line. Each tool is colour‑coded by how careful it is:

🟢 **reads** (runs instantly, never changes anything) · 🟡 **changes files** (asks first) · 🔵 **runs / launches** (asks first)

| Tool | What it does | |
|---|---|---|
| `read_file` | Read any text file — big files come **one page at a time** (12,000 characters, with a "next offset" hint) so ChatGPT never loses the middle | 🟢 |
| `read_output` | Read the next page of a long `run_command` output | 🟢 |
| `list_dir` | List what's in a folder | 🟢 |
| `find_files` | Find files by name (e.g. all your PDFs) | 🟢 |
| `search_in_files` | Search *inside* files for text | 🟢 |
| `system_info` | OS, CPU, RAM, disk space, uptime | 🟢 |
| `list_processes` | What's running / using memory | 🟢 |
| `write_file` | Create or overwrite a file | 🟡 |
| `edit_file` | Find‑and‑replace inside a file | 🟡 |
| `manage_path` | Make / move / copy / delete files & folders | 🟡 |
| `run_command` | Run any PowerShell command (anything above + more) | 🔵 |
| `open_path` | Open a file, folder, app, or website | 🔵 |
| `kill_process` | Stop a frozen or unwanted program | 🔵 |
| `screenshot` | Capture the screen so ChatGPT can **see** it | 🔵 |
| `start_job` · `job_status` · `list_jobs` · `stop_job` | Run **long tasks in the background** (builds, downloads, servers) and check progress | 🔵🟢 |
| `move_mouse` · `mouse_click` · `type_text` · `press_keys` · `scroll` | **Control the mouse & keyboard** — operate any app, not just the terminal | 🔵 |
| `list_apps` · `app_state` · `app_click` · `app_type` · `app_key` · `app_set_value` · `app_scroll` · `app_drag` · `app_action` | **Computer use** — read an app's window as a screenshot plus a numbered list of its buttons, fields and menus, then act on a control by its number. Works on apps in the background | 🟢🔵 |
| `list_windows` · `window_control` · `launch_app` | **Windows & apps** — list open windows; focus, minimize, maximize, restore, move/resize or close one; start any app by name (Store apps too) | 🟢🔵 |

> By default, 🟢 reads happen instantly (they're harmless) while 🟡/🔵 actions wait for your **Approve** — so ChatGPT can freely *look around*, but never *change* anything without your okay. Switch to **Always allow** on the settings page for fully hands‑off.

> 🖱️ **Computer use (recommended for apps):** `list_apps` → `app_state` → `app_click` / `app_set_value` / `app_key` → `app_state` again. ChatGPT clicks a button by its *name and number* instead of guessing pixel positions, which is far more reliable, and the app can stay in the background. Powered by the open-source [open-computer-use](https://github.com/iFurySt/open-computer-use) engine (MIT): install it once with `npm i -g open-computer-use`. Long control lists are paged like long files.

> 👀 **See-and-click:** `screenshot` + `move_mouse`/`mouse_click`/`type_text` let ChatGPT look at your screen and then operate apps — open a program, click buttons, fill a form. (Mouse/keyboard control is Windows‑only for now.)

---

## 🌍 Control your other machines too (VPS · remote Windows · RDP)

PC Commander isn't limited to the PC it runs on. Tell it about your servers once, then command them all from the same chat.

| Tool | What it does | |
|---|---|---|
| `add_server` / `list_servers` / `remove_server` | Save your servers by nickname (uses SSH keys — no passwords stored) | 🟡🟢 |
| `ssh_run` | Run commands on a Linux **VPS** over SSH — install, deploy, restart services, read logs | 🔵 |
| `ssh_copy` | Upload/download files to/from a server (SCP) | 🔵 |
| `winrm_run` | Run PowerShell on a remote **Windows** machine | 🔵 |
| `rdp_connect` | Open a **Remote Desktop** session to a Windows server | 🔵 |

**Example:**

> *"Save my server: nickname **london**, host 203.0.113.9, user root, key `~/.ssh/id_ed25519`."*
> *"On **london**, how much disk is free and is nginx running?"*
> *"Deploy the latest build to **london** and restart the service."*

<sub>💡 For SSH, set up key login first (`ssh-copy-id user@host`) — it's safer than passwords and lets the agent connect without prompts. For `winrm_run`, the remote Windows box needs PowerShell Remoting enabled. For `rdp_connect`, the remote desktop window opens on your PC for you to finish signing in.</sub>

---

## 🤖 Agent superpowers (memory, automation, reach)

Beyond doing things *right now*, PC Commander can remember, run on a schedule, reach the internet, and tell you when it's done.

| Area | Tools | What it unlocks |
|---|---|---|
| **🧠 Memory** | `remember` · `recall` · `forget` | Remembers your setup, preferences, and projects **across chats** — it gets to know your world. |
| **⏰ Scheduler** | `schedule_task` · `list_scheduled` · `cancel_scheduled` · `run_scheduled_now` | Runs things on a repeat (*"every morning, back up Documents and ping me"*) — even when you're not chatting. |
| **🔔 Notifications** | `configure_notify` · `notify` | Pings **you** on Telegram / Discord / any webhook — e.g. when a long job finishes. |
| **🌐 Internet** | `http_request` · `download_file` | Call any web API, hit webhooks, download files. |
| **⏳ Long-running jobs** | `start_job` · `job_status` · `list_jobs` · `stop_job` | Background tasks (builds, downloads) that keep running, **keep the PC awake**, and **notify you when done**. |
| **🗄️ Survive-anything jobs** | `start_remote_job` · `remote_job_log` | Run hours-long tasks on a **server** (via `nohup`) so they survive disconnects *and your laptop shutting down*. |
| **🚀 Fleet** | `ssh_run_all` | Run one command across **all** your servers at once. |
| **📋 Extras** | `read_clipboard` · `set_clipboard` · `keep_awake` · `screen_size` | Clipboard access, pin the PC awake, check screen resolution. |

**Examples:**

> *"Remember that my main project is at C:\\dev\\app and I deploy to the **london** server."*
> *"Every day at startup, check for Windows updates and Telegram me the result."*
> *"Download the latest release from this URL, then on **london** run the migration as a remote job and tell me when it finishes."*

---

## 🧠 Full agent mode

PC Commander isn't just a pile of tools — it can plan, edit code, drive a browser, and even run itself.

| Area | Tools | What it unlocks |
|---|---|---|
| **🤯 Autonomous engine** | `configure_agent` · `agent_task` · `agent_status` | Give it a **goal** and it plans → acts → checks → repeats **on its own**, using all its tools, then reports back. Powered by your own LLM key (OpenAI / Groq / local Ollama / LM Studio — anything OpenAI-compatible). |
| **🧑‍🤝‍🧑 Subagents** | `spawn_subagent` · `subagent_status` · `list_subagents` · `subagent_result` · `stop_subagent` | Run **several autonomous workers in parallel**. ChatGPT (single-threaded in Chat) dispatches tasks; each subagent is its own plan→act→observe loop with a **scoped** toolset, running in the background. |
| **👨‍💻 Developer agent** | `update_plan` · `apply_edits` · `write_files` · `git` · `project_tree` | Works like a coding agent: keeps a to-do list, edits many files atomically, scaffolds projects, runs git, maps a codebase. |
| **🌍 Web agent** | `browser_open` · `browser_read` · `browser_click` · `browser_type` · `browser_eval` · `browser_screenshot` | Drives a **real browser** (your installed Chrome/Edge) — log in, click, fill forms, scrape, operate web apps. Run `npm run install-browser` once to enable. |
| **🛡️ Safety net** | `undo_last` · `restore_backup` · `list_backups` · `set_dry_run` · `store_secret` | Deletes go to the **Recycle Bin**; every change is snapshotted (undo anytime); **dry-run** previews without doing; secrets are **encrypted** and used via `${secret:NAME}` so they never appear in chat. |
| **🎛️ Control center** | the settings page | A live dashboard: mode, dry-run, every capability, running jobs, schedules, servers, memory, and recent activity at a glance. |

**Example — hand it a whole job:**

> *"**Autonomous task:** create a Python project in C:\\dev\\scraper, write a script that pulls the top Hacker News titles, run it, save the output to titles.txt, and tell me when it's done."*

With the autonomous engine configured, it'll plan the steps, create the files, run it, fix any errors, and report back — on its own.

> ⚠️ The autonomous engine acts without asking between steps (you approve *launching* it). Catastrophic actions are still blocked by the safety guard, and sensitive ones are skipped. Keep **dry-run** on while you're learning to trust it.

### 🧑‍🤝‍🧑 Subagents — a team that works in parallel

ChatGPT in the **Chat** tab is single-threaded — it can't fan work out on its own. Subagents fix that: ChatGPT dispatches tasks and **PC Commander runs the workers**. Each `spawn_subagent` starts an autonomous worker in the **background** (its own plan→act→observe loop) and returns immediately, so you can spawn several and they run **in parallel**. Each gets a **scoped** toolset via a role — `coder` (edit + run), `tester` (read + run, no writes), `researcher` (read-only + web), or `full` — or an explicit tool allow-list. Poll with `subagent_status` / `list_subagents`, collect with `subagent_result`, stop one with `stop_subagent`.

> *"Spawn three subagents: one to add input validation to the auth module (coder), one to write tests for the payments module (coder), and one to audit the repo for TODOs (researcher). Tell me when each finishes."*

Subagents use the same engine as `agent_task`, so **`configure_agent` must be set first**. They're guard-checked (catastrophic actions blocked, sensitive ones skipped), the PC is kept awake while any run, and you get a notification when each finishes.

---

## ✅ What you'll need

| | |
|---|---|
| 🖥️ **A PC to control** | **Windows** is fully supported. **macOS & Linux** work too for the core (shell, files, system info, background jobs, SSH) — the screen/mouse tools are Windows‑only for now. You can *talk* to it from any device (phone, Mac, web). |
| ⏱️ **About 10 minutes** | One-time setup. After that it runs by itself. |
| 💬 **A ChatGPT account** | One that lets you add "connectors" (a connector is just a plug-in that lets ChatGPT talk to your PC). |
| 🌐 **A website address you own** *(optional)* | If you have one (like `yourname.com`), you get a permanent link that never changes. No domain? You can still use the free temporary option. |

> **Never set anything like this up before?** That's fine. Every step below is copy‑paste. You don't need to understand the commands — just follow along.

---

## 🚀 Setting it up

> **How to open "PowerShell"** (you'll need it below): press the **Start** button, type **PowerShell**, and press **Enter**. A blue window opens. That's where you paste the commands.

### Step 1 — Get the files onto your PC

In PowerShell, paste this and press Enter:

```powershell
git clone https://github.com/Lucifer-xD/pc-commander.git
cd pc-commander
```

<sub>💡 If it says "git is not recognized", install **[Git](https://git-scm.com/download/win)** first (click Next through the installer), then try again. You'll also need **[Node.js](https://nodejs.org)** — download the big green "LTS" button and install it.</sub>

### Step 2 — Run the installer

Paste this:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

This sets everything up and makes it **start automatically every time you turn your PC on**. When it finishes, it prints a link ending in a long code — that long code is **your private key**. Keep that window open for the next step.

### Step 3 — Get your link

ChatGPT needs a web address to reach your PC. Pick one:

<table>
<tr>
<td width="50%" valign="top">

**🅰️ Just trying it out?**

```powershell
npm run quick
```

Gives you a **temporary** link right away. Good for a first test. (The link changes each time, so it's not for everyday use.)

</td>
<td width="50%" valign="top">

**🅱️ Want it permanent? (recommended)**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-domain.ps1 -Hostname pc.yourdomain.com
```

Uses a website address you own to make a **permanent link that never changes**. A browser opens once to sign in — just follow the prompts.

</td>
</tr>
</table>

Either way, you'll get a link that looks like this — **copy it**, you'll paste it into ChatGPT next:

```
https://pc.yourdomain.com/mcp?key=your-long-private-code
```

### Step 4 — Connect it to ChatGPT

1. Go to **chatgpt.com** → click your name → **Settings** → **Connectors**.
2. Click **Add custom connector** (you may first need to turn on *Advanced → Developer mode*).
3. Fill in the boxes:

   | Box | What to put |
   |---|---|
   | **Name** | `PC Commander` |
   | **Description** | `Securely run things on my own Windows PC. I approve each action.` |
   | **URL** | the link you copied in Step 3 |
   | **Authentication** | choose **No authentication** *(your key is already in the link)* |
   | **Icon** | pick the file `assets/icon-connector.png` from this folder |

4. Tick **"I trust this application"** and click **Create**.
5. Start a **new chat**, click the **➕** near the message box, and make sure **PC Commander** is switched **on**.

🎉 **Try it:** type *"using PC Commander, what's my Windows version?"* — a box pops up on your PC, you click **Approve**, and the answer appears in the chat.

### Step 5 — Make ChatGPT use it automatically

So you don't have to say "use PC Commander" every time, give ChatGPT a standing instruction.

Go to **Settings → Personalization → Custom Instructions**, and in the box that says *"How would you like ChatGPT to respond?"*, paste this:

```text
I have a connector called PC Commander that runs things on my own Windows PC.
Whenever I ask about my PC / computer / laptop — checking if something is
installed, running something, finding or tidying files, system info, and so on
— use PC Commander directly and tell me the result, right here in the chat.
Don't tell me to do it myself, and don't switch me to "Work" or "Agent" mode —
stay in the normal chat. Every action already asks me to approve it on my PC.
```

<sub>📱 **Using the ChatGPT desktop app too?** Do the same thing there under *Settings → Personalization → Custom instructions*. The app and the website remember these separately, so paste it in both.</sub>

**That's it — you're done.** From now on, just ask ChatGPT about your computer and it'll handle it.

---

## ♻️ It stays alive by itself (reboot · sleep · crash)

You never have to start anything by hand. The installer sets up three things that run quietly in the background with **no window and no admin rights**:

| Piece | What it does |
|---|---|
| **Server** | the connector itself, on `:8787` |
| **Tunnel** | the Cloudflare link that gives ChatGPT a public URL *(only if you set up a permanent domain)* |
| **Watchdog** | a tiny loop that checks the other two every 30 seconds and restarts whatever stopped answering |

So if any of these happens, it fixes itself within about half a minute — you don't have to touch it:

- 🔌 **You restart your PC** → everything comes back at logon.
- 😴 **Your laptop sleeps and wakes** → the watchdog notices the public link went quiet and re-dials the tunnel. *(This is the classic "it worked, then ChatGPT suddenly couldn't reach my PC" problem — handled.)*
- 💥 **The server or tunnel crashes** → the watchdog restarts it.

It's careful about it, too: it only ever restarts the tunnel when the public URL has genuinely gone dark (not when a page just returns an error), and it never touches other `cloudflared` tunnels you may be running for something else.

<sub>Want to see what it's been doing? Open **`scripts\autostart\watchdog.log`**. Want to turn auto-start off? Press **Start**, type `shell:startup`, Enter, and delete the **PC Commander** shortcuts.</sub>

---

## 🎚️ How careful should it be?

You decide how much it asks before doing things. Open the settings page (the installer put a shortcut on your Desktop, or use the `http://127.0.0.1:8787/...` link from Step 2):

<div align="center"><img src="assets/docs/settings.png" alt="The settings page" width="380"></div>

- **Ask each time** *(safest, recommended)* — a box pops up for every single action and waits for your **Approve**. Nothing runs until you click.
- **Always allow** *(hands-off)* — things run instantly with no pop-up. Faster, but it will do **whatever** ChatGPT asks. Only use this when you're watching.

You can switch between them anytime, and it takes effect on the very next request.

<details>
<summary><b>One more thing: ChatGPT might also ask its own "allow?" question</b></summary>

<br>

There are two separate "are you sure?" checks, and that's on purpose:

1. **Your PC's pop-up** (the one above) — the main safety net. Always protects you.
2. **ChatGPT's own prompt** — the first time, ChatGPT may ask *"allow PC Commander to run this?"*. Choose **Always allow** there to stop being asked. (On the desktop app this lives under *Settings → Personalization → Permissions → Custom rules*.)

**Want zero interruptions?** Set both to allow. **Want maximum safety?** Leave both on ask.

</details>

---

## 🔐 Is this safe?

Yes — and here's why, in plain terms:

- **A safety guard that can't be overridden.** Even in "Always allow", PC Commander **refuses** catastrophic actions (wiping a drive, deleting Windows, `rm -rf /`) and **forces a confirmation** for sensitive ones (shutdown, user accounts, firewall). It won't touch system folders. You can tighten it further in `data/guard.json`.
- **A runaway-loop brake.** If the agent tries more than ~120 actions a minute, it's throttled — so a bad loop can't run wild.
- **You approve everything.** Even if someone somehow got your link, nothing would run on your PC until *you* clicked Approve on your own screen.
- **Only you have the link.** It contains a long secret code. Don't share it or post it anywhere, and you're the only one who can get in.
- **It's your computer, your rules.** It only listens to your private link — it's not open to the internet, and there are no doors left unlocked.
- **Everything is written down.** Every request and your decision is saved in a log file on your PC, so you can always see what happened.

> Think of **"Always allow"** like handing someone your keyboard — only turn it on when you're paying attention. The rest of the time, keep **"Ask each time"** on.

---

## ❓ It's not working — help

| What you're seeing | What to do |
|---|---|
| ChatGPT says *"handoff was declined"* | You didn't click **Approve** in time (it waits about a minute). Try again and click it, or switch to **Always allow**. |
| It keeps saying *"Continue in Work"* | Make sure **PC Commander** is switched on in the ➕ menu, add the Step 5 instruction, and click **"Stay in Chat"**. Tip: starting your message with **@PC Commander** forces it. |
| *"git is not recognized"* / *"node is not recognized"* | Install **[Git](https://git-scm.com/download/win)** and **[Node.js](https://nodejs.org)**, then close and reopen PowerShell. |
| Nothing works after I restarted my PC | It should start on its own. If not, press **Start**, type `shell:startup`, Enter — you should see **PC Commander** shortcuts there. |
| I want a new secret code | Delete the file `data\token.txt`, restart your PC, and update the link in ChatGPT with the new one. |

Still stuck? [Open an issue](https://github.com/Lucifer-xD/pc-commander/issues) and describe what happened.

---

<details>
<summary><b>🧩 For developers (the technical bits)</b></summary>

<br>

PC Commander is a small [Model Context Protocol](https://modelcontextprotocol.io) server exposing one tool, `run_command`, over streamable HTTP. The server binds to `127.0.0.1` only; a Cloudflare named tunnel provides the public HTTPS hostname. Requests carry a token (`?key=` or Bearer); each command passes an approval gate (a topmost WinForms dialog) unless mode is `always`.

```
src/
  server.mjs      MCP server; registers all tools; risk+guard+rate-limit; /health, settings API
  tools.mjs       core tools (files, search, system, screenshot) — cross-platform
  remote.mjs      SSH / SCP / WinRM / RDP, fan-out, persistent remote jobs, registry
  jobs.mjs        durable background jobs (keep-awake, notify-on-done)
  scheduler.mjs   recurring/one-shot scheduled tasks (persisted, re-armed on start)
  memory.mjs      long-term memory (remember/recall/forget)
  web.mjs         http_request / download_file
  notify.mjs      Telegram / Discord / webhook notifications
  extra.mjs       clipboard, keep_awake, screen_size
  keepawake.mjs   stops the PC sleeping while jobs run
  gui.mjs/.ps1    mouse & keyboard control (Windows)
  computer.mjs    computer use by accessibility (bridge to the open-computer-use engine) + window tools
  windows.ps1     list / focus / minimize / maximize / move / close windows, launch apps (Windows)
  guard.mjs       safety guard: block catastrophic, confirm sensitive, protect system dirs
  shell.mjs       per-OS shell selection (PowerShell / sh)
  exec.mjs        runs a command in the OS shell, captures stdout/stderr/exit code
  approve.mjs/.ps1  the topmost Approve/Deny dialog with a countdown
  screenshot.ps1  screen capture (Windows)
  config.mjs      defaults + generates data/token.txt
  log.mjs         JSONL logging
  run.mjs         quick-start launcher (server + temporary tunnel)
  settings.html   the Ask / Always-allow page + capability list
scripts/
  install.ps1       deps + key + auto-start the server at logon
  setup-domain.ps1  named Cloudflare tunnel + permanent URL + auto-start the tunnel
  rotate-key.ps1    generate a new key and restart
  autostart/*.vbs   windowless launchers used by the Startup shortcuts
cloudflared/
  pc-commands.example.yml   template (your real one is generated & gitignored)
```

Config knobs live in `data/config.json` (`maxPerMinute`, timeouts, `autoApprove`) and `data/guard.json` (`enabled`, `protectedPaths`, `allowedRoots`, extra `block`/`confirm` patterns).

Run `npm start` to launch just the server, `npm run quick` for server + temporary tunnel. PRs welcome.

</details>

<div align="center">
<br>
<sub>MIT License · Made for anyone who'd rather just <i>ask</i> their computer.</sub>
</div>
