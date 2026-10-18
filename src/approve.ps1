param([Parameter(Mandatory=$true)][string]$RequestFile, [int]$TimeoutSec = 180)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$req = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ChatGPT wants to run a command on this PC'
$form.Size = New-Object System.Drawing.Size(640, 420)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false; $form.MinimizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(24,24,32)
$form.ForeColor = [System.Drawing.Color]::White

$lblDir = New-Object System.Windows.Forms.Label
$lblDir.Text = 'Folder:  ' + $req.cwd
$lblDir.AutoSize = $true; $lblDir.Location = '16,14'
$lblDir.ForeColor = [System.Drawing.Color]::FromArgb(160,170,200)
$form.Controls.Add($lblDir)

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'
$box.Text = $req.command
$box.Font = New-Object System.Drawing.Font('Consolas', 11)
$box.BackColor = [System.Drawing.Color]::FromArgb(14,14,20)
$box.ForeColor = [System.Drawing.Color]::FromArgb(230,235,255)
$box.Location = '16,42'; $box.Size = New-Object System.Drawing.Size(596, 270)
$form.Controls.Add($box)

$approve = New-Object System.Windows.Forms.Button
$approve.Text = "Approve"; $approve.Size = New-Object System.Drawing.Size(150, 40)
$approve.Location = '320,330'
$approve.BackColor = [System.Drawing.Color]::FromArgb(99,102,241); $approve.FlatStyle = 'Flat'
$approve.DialogResult = [System.Windows.Forms.DialogResult]::Yes
$form.Controls.Add($approve)

$deny = New-Object System.Windows.Forms.Button
$deny.Text = "Deny"; $deny.Size = New-Object System.Drawing.Size(130, 40)
$deny.Location = '482,330'
$deny.BackColor = [System.Drawing.Color]::FromArgb(60,60,72); $deny.FlatStyle = 'Flat'
$deny.DialogResult = [System.Windows.Forms.DialogResult]::No
$form.Controls.Add($deny)

$form.AcceptButton = $approve; $form.CancelButton = $deny
$script:left = $TimeoutSec
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  $script:left--
  $deny.Text = "Deny ($script:left)"
  if ($script:left -le 0) { $timer.Stop(); $form.Tag = 'timeout'; $form.Close() }
})
$timer.Start()
$form.Add_Shown({ $form.Activate(); $approve.Focus() })
$result = $form.ShowDialog()
$timer.Stop()
if ($form.Tag -eq 'timeout') { exit 2 }
if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 } else { exit 1 }
