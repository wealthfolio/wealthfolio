/// What a streamed reply's `content` adds after the `sent` text. The
/// framework reports the whole reply so far each time; the app takes deltas.
///
/// Compared by Unicode scalars, not characters: a snapshot can end inside a
/// character that the next one extends (a skin tone, an Arabic vowel mark),
/// and a character-wise prefix would send that character twice. A snapshot
/// that rewrites earlier text, which the framework does not do, sends only its
/// new end.
func textDelta(from sent: String.UnicodeScalarView, to content: String.UnicodeScalarView) -> String {
    var common = 0
    for (old, new) in zip(sent, content) {
        guard old == new else { break }
        common += 1
    }
    return String(String.UnicodeScalarView(content.dropFirst(common)))
}
