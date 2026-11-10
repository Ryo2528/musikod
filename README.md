# Musiko MP3

Convert a public YouTube video to MP3 and edit its title, artist, album, and cover art. If YouTube rejects Vercel's request, the page retries once. **Use an MP3 file** lets you tag an existing MP3 in your browser without uploading the audio.

## Deploy a new copy on Vercel

1. Extract the ZIP to a folder and create an empty GitHub repository.
2. Open the new repository's upload page and drag the **contents** of the extracted folder from File Explorer into the upload area. Keep `api`, `public`, and `scripts` as folders. Before committing, confirm GitHub shows `api/track.mjs`, `public/index.html`, and `scripts/install-tools.mjs`. `package.json` and `vercel.json` belong at the repository root. [GitHub upload instructions](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)
3. In Vercel, choose **Add New → Project**, import the new repository, and select **Other** for Framework Preset. Leave Root Directory at the repository root, keep **Fluid Compute** enabled, and deploy. `vercel.json` sets the build and output directories, and `package.json` selects Node.js 24.x. [Vercel GitHub setup](https://vercel.com/docs/git/vercel-for-github)

```text
api/
  track.mjs
public/
  app.js
  index.html
  mp3-tags.js
  styles.css
scripts/
  install-tools.mjs
package.json
vercel.json
```

The Vercel build fetches and verifies the Linux conversion tools. You don't need to install the tools on Windows or upload the `bin/` directory. The app needs no environment variables or database.

A new deployment gives you a new Vercel URL. YouTube can still reject requests from Vercel. If that happens, open **Use an MP3 file** and add the tags and artwork to an MP3 you already have permission to use. Direct conversion accepts one public video up to 20 minutes long with source audio up to 60 MB. Custom covers can be up to 2 MB.
