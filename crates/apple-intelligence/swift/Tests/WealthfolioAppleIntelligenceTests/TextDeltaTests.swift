import XCTest

@testable import WealthfolioAppleIntelligence

/// Run with `swift test` in `crates/apple-intelligence/swift`.
final class TextDeltaTests: XCTestCase {
    /// The text the app shows after receiving each snapshot's delta.
    private func streamed(_ snapshots: [String]) -> String {
        var sent = String.UnicodeScalarView()
        var shown = ""
        for snapshot in snapshots {
            let content = snapshot.unicodeScalars
            shown += textDelta(from: sent, to: content)
            sent = content
        }
        return shown
    }

    func testPlainTextArrivesOnce() {
        XCTAssertEqual(streamed(["Hello", "Hello, wor", "Hello, world."]), "Hello, world.")
    }

    func testAnEmojiThatGainsASkinToneIsNotRepeated() {
        XCTAssertEqual(streamed(["Gain 👍", "Gain 👍🏽 ok"]), "Gain 👍🏽 ok")
    }

    func testALetterThatGainsACombiningMarkIsNotRepeated() {
        XCTAssertEqual(streamed(["cafe", "cafe\u{301} ok"]), "cafe\u{301} ok")
    }

    func testArabicAndDevanagariMarksAreNotRepeated() {
        XCTAssertEqual(streamed(["مرحب", "مرحبًا"]), "مرحبًا")
        XCTAssertEqual(streamed(["नमस", "नमस्ते"]), "नमस्ते")
    }

    func testAnEmojiJoinedPieceByPieceIsNotRepeated() {
        XCTAssertEqual(streamed(["👩", "👩\u{200D}", "👩\u{200D}💻 done"]), "👩\u{200D}💻 done")
    }

    func testAnUnchangedSnapshotSendsNothing() {
        XCTAssertEqual(textDelta(from: "Same".unicodeScalars, to: "Same".unicodeScalars), "")
    }
}
