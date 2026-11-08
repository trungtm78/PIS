# Background music for the clips: proposals for the owner to approve

Nothing is downloaded by the tooling. The mixer (`mix.mjs --music <file>`) takes any audio file, so the choice below only decides which file the owner puts on disk. The music must be light, instrumental, without a vocal, at least 3 minutes (the mixer loops it and fades it in and out), and under a licence that allows commercial use in a customer film without attribution.

## Status of this list

The three entries below were found by a web search on 2026-11-08 and each listing showed the licence CC0 (public domain dedication). The pages could not be opened from the build machine (the site answered 403 to the fetch tool), so **the licence line and the length of each track were NOT confirmed on the page**. Before approving, the owner or a reviewer opens the page, reads the licence line, and writes the result in the table of "Approval".

| # | Candidate | Author | Mood | Licence in the listing | Page |
|---|---|---|---|---|---|
| 1 | "Classical Pop (Instrumental)" | Pro Sensory | soft piano with a light pulse, calm, steady | CC0 (the author states that all the music is public domain) | https://opengameart.org/content/classical-pop-instrumental |
| 2 | "Chill Beats Collection" | Holizna | relaxed light beat, instrumental, a pack of several tracks to choose from | CC0 | https://opengameart.org/content/chill-beats-collection |
| 3 | "Music for the background" (the collection of calm CC0 tracks of the same site is the fallback source: https://opengameart.org/content/music-for-the-background) | listed on the page | calm, in the background | CC0 | https://opengameart.org/content/music-for-the-background |

Licence text of CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/

## How they fit the clips

- The government and state-enterprise audience asks for a sober tone: candidate 1 (piano) is the safest for both clips; candidate 2 is lighter and suits the phone and analytics chapters if the owner wants more energy; candidate 3 is a spare.
- The mixer lowers the music by 20 dB, ducks it further under the voice (sidechain compressor, attack 15 ms, release 450 ms) and normalises the whole mix to minus 16 LUFS, so a track that is loud or has a strong low end still sits under the voice. A track with a vocal or with strong dynamics (drops) must not be used.
- One track per clip is enough: the same file runs under the main video and every chapter cut (the chapter cuts start the file from its beginning).

## Approval (to fill in)

| # | Licence read on the page (date, line) | Length | Approved by the owner |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |

Keep the licence page address and the date it was read in `docs/` next to the final film, because the licence of a track can be changed by its author.

## Other sources that are fine if the owner prefers (all need the same check)

- Free Music Archive, filter "Public Domain / CC0": https://freemusicarchive.org/search?music_copyright=cc0 (not confirmed from the build machine).
- Pixabay and similar sites use their own content licences, not CC0: they allow free use but forbid reselling the track alone; read the licence before choosing from them.
- Do not use tracks under CC BY unless the film shows the attribution line; the clips have no credits card.
