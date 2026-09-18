export function isValidBackupPassword(password: string): boolean {
  const length = Array.from(password).length;
  return length >= 12 && length <= 1024 && new TextEncoder().encode(password).length <= 4096;
}

export function generateBackupPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  // Reject the uneven tail so every character has the same probability.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const random = new Uint8Array(1);
  return Array.from({ length: 24 }, () => {
    do {
      crypto.getRandomValues(random);
    } while (random[0] >= limit);
    return alphabet[random[0] % alphabet.length];
  }).join("");
}
