# vhs script that produces the README demo (https://github.com/charmbracelet/vhs)
# Recorded for real: a scripted agent (docs/assets/demo-agent.mjs) sends an MCP
# send_payment call through the gateway -> the example policy parks it for
# approval -> a human lists the pending call and denies it -> the agent gets a
# plain-language isError result instead of a wire transfer.
#
# Reproduce from the repository root:
#   npm ci && npm run build && npm install -g . && vhs docs/assets/demo.tape
# The example policy writes ./toolgate-audit.jsonl into the cwd during the
# recording; delete that file afterwards (it is gitignored either way).
Output docs/assets/demo.gif
Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 640
Set Padding 12
Set Theme "Dracula"
Set TypingSpeed 15ms

Type "export TOOLGATE_CONTROL_URL=http://127.0.0.1:39411"
Enter
Type "node docs/assets/demo-agent.mjs | toolgate run --policy examples/policy.yaml --control-port 39411 -- node examples/demo-server.mjs &"
Enter
Sleep 4s
Type "toolgate pending"
Enter
Sleep 2s
Type "toolgate deny $(toolgate pending | awk '{print $1}')"
Enter
Sleep 3s
