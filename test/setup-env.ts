for (const key of Object.keys(process.env)) {
  if (key.startsWith("KIKIMORA_")) {
    delete process.env[key];
  }
}
