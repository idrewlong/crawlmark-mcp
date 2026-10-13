# Demo video plan

A 15–30 second launch video for crawlmark (Phase 11). The script and shot list are in [blog-outline.md](blog-outline.md#demo-video-shot-list-about-25-seconds). Build it after Phase 10, so the installer looks final.

## Approach

For a developer tool like this, the polished launch videos are usually real recordings, edited tight with music, rather than AI-generated footage.

| Tool | For | Why |
|---|---|---|
| [VHS](https://github.com/charmbracelet/vhs) (Charm, the same family as the library the shrinkr CLI uses) | The terminal shots | You write a script of keystrokes and it records a perfectly timed clip. Re-render any time the CLI changes. Free |
| Screen Studio (Mac) | The Claude Desktop shots | Smooth automatic zoom and cursor motion, which is the look most product launches use. Paid |
| [Remotion](https://www.remotion.dev/) | Putting it together | Builds the final video from React code: titles, cuts, music timing. Renders square and vertical versions too. Free for individuals |

**Optional extras:** an ElevenLabs voiceover, or a music track from a royalty-free library.

**The fully AI route** is possible too: text-to-video tools for animated scenes, or a template-based demo maker. But AI video tends to garble terminal text and UI, which is the core of this demo.

## Plan

1. Claude writes the VHS script for the terminal shots (`npx crawlmark-mcp@latest init`: banner, checks turning green, apps registered, summary box) and renders it.
2. You record the Claude Desktop shots in Screen Studio, using example.com data only.
3. Claude builds the final cut in Remotion: titles, cuts, music timing, and 16:9, 1:1 and 9:16 versions.

## Rules

- Only example.com data in every shot. No real client names, domains or numbers.
- 15–30 seconds. End on the install command.
- Re-render the VHS clip whenever the installer changes before launch.

## Sources

- [Remotion (everydev.ai)](https://www.everydev.ai/tools/remotion)
- [Remotion reviews (subscribed.fyi)](https://subscribed.fyi/remotion/reviews/)
- [Demo producer: VHS and Remotion workflow (claudeskills.info)](https://claudeskills.info/skills/yonatangross/orchestkit/demo-producer/)
