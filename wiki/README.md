# Wiki source

These are the GitHub wiki pages, kept in the repo so they are versioned and reviewed like
everything else. The wiki itself is a separate git repository
(`hive-pocket-media-player.wiki.git`) and **GitHub will not create it until one page has been
saved through the web UI** — which is why these live here and are pushed across by hand.

## First time only

Create any page at https://github.com/cobrahjh/hive-pocket-media-player/wiki/_new and save it.
That brings the wiki repository into existence. Then:

    git clone https://github.com/cobrahjh/hive-pocket-media-player.wiki.git
    copy wiki\*.md into the clone
    git -C <clone> add -A && git -C <clone> commit -m "wiki" && git -C <clone> push

## After that

Edit the files here, commit them with the rest of the app, and copy them across the same way.
The filename is the page name: `Your-music-folder.md` is the page linked as `[..](Your-music-folder)`.
