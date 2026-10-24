// @chatwing
//
// Serves the iOS builds `ios/share.sh` uploads to the ios-builds bucket, one
// per app (each upload replaces that app's last; the bucket deletes anything
// a week old): /<App>/ is the install page, beside its manifest.plist and
// <App>.ipa. Deployed once, for every app: `npx wrangler deploy` in here.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let key = decodeURIComponent(url.pathname.slice(1));
    if (!key) return new Response("Not found", { status: 404 });
    // /Miks is the page too, and its links are relative to /Miks/.
    if (!key.includes("/")) return Response.redirect(`${url.origin}/${key}/`, 301);
    if (key.endsWith("/")) key += "index.html";

    const object = await env.BUILDS.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    // Always the latest build, never a copy cached from the one before.
    headers.set("cache-control", "no-store");
    return new Response(object.body, { headers });
  },
};
