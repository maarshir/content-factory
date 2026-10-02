// Узел «Ленты»: список лент RSS из src/sources.json, по одному элементу на ленту.
// @include src/sources.json as SOURCES

return SOURCES.sources.map((s) => ({ json: { name: s.name, url: s.url, kind: s.kind } }));
