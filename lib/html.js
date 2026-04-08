function htmlPage(title, msg) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body style="font-family:system-ui;padding:24px;max-width:520px;margin:auto">
<h2>${title}</h2>
<p>${msg}</p>
</body></html>`;
}

module.exports = { htmlPage };
