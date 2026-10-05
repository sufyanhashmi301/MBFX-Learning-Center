@Sufyan Hashmi 

✅ Fixed since Friday, thanks: release-folder deploy, health check + rollback, DB backup, new deployment ID on every deploy.

🔴 1. App runs out of memory and restarts (site goes down)

The app idles at ~1 GB and pm2 kills it at 1.5 GB (max_memory_restart).
Loading ~all pages one by one (like a Google crawl), or 6 visitors at once, pushed it to 1.64 GB. It restarted and visitors got 502 errors.
It happened on 21 Sep and twice today.
Please find why memory grows with every page (probably Next's in-memory cache).
Run 2 instances (cluster mode) so a restart doesn't take the site down.
The server is also using 4.5 of 6 GB of swap.
🟠 2. Click delay (public site + admin)

The server is fast: every page renders in 20–200 ms. The delay is in the browser.
The home page sends 795 KB of HTML (537 KB is embedded page data), plus 529 KB of JavaScript and a 940 KB video (practice.mp4).
After the page loads, the browser is blocked for ~1.5 s, so clicks do nothing during that time.
Please reduce the data passed to client components, lazy-load the video, and split the JS bundles.
🔴 3. Cloudflare still caches 404s for /_next/static/ files

Test: request a missing chunk twice. First MISS, second HIT on the 404.
Add the nginx location /_next/static/ block from your own docs/ops/deploy.md §6 to the server. It's still not there.
Or add a Cloudflare Cache Rule: hostname learn.mbxpro.com, status 404 → no cache.
🟡 4. Errors in the pm2 log

"Unexpected cache miss after cache warming phase during prerendering". A cached function gets non-deterministic arguments. Please fix; it also adds load.
Better Auth: "Social provider google/github is missing clientId or clientSecret". Either add the keys or turn those providers off, so the buttons don't fail.
🟡 5. Security policy (CSP) blocks

eval is blocked on the home page and on many /keystone admin pages. Please find which feature uses it and whether it breaks anything.
The home page CSP doesn't allow Google reCAPTCHA, so clicking through to sign-in/sign-up logs a CSP error. Captcha still works, but please add reCAPTCHA to the CSP on all pages.
Cloudflare Email Obfuscation is still on, and its script is blocked on admin pages. Please turn it off in Cloudflare (Scrape Shield).
🟡 6. Missing pages return 200 instead of 404

/about, /contact, /privacy, /terms and any typo URL return 200 with a "not found" page. Bad for SEO. They should return a real 404.
If /about, /privacy and /terms should exist, please create them.
🟢 7. Small things

The sitemap lists /ar/, which redirects (308). List /ar instead.
Broken shell files on the server:
/etc/profile: the first line is cut (c/profile: ...) and the file ends with a stray do / sleep 30.
~/.bashrc line 13: umask 007export PATH=... needs a line break after 007.

8. React hydration error #418 on admin (/keystone/profile)

Console: Minified React error #418 (args: text). The page text doesn't match the server render, so React re-renders the whole page in the browser. This is likely why admin clicks feel slow and dark mode may not work.
Likely cause: Cloudflare Email Obfuscation changes the email text in the HTML before React hydrates.
Quick test: turn off Scrape Shield → Email Address Obfuscation in Cloudflare for learn.mbxpro.com, then purge the hostname and reload. If the error goes away, that was it.
If it stays: check for dates/times or toLocaleString() that render differently on server and browser, or Math.random()/Date.now() in rendered output. Run the dev build to get the full error message.

🟢 9. ~56 "preloaded but not used" warnings

Too many <link rel="preload"> for files the page never uses. Please remove the unneeded preloads (fonts/chunks) and check they have the correct as value.