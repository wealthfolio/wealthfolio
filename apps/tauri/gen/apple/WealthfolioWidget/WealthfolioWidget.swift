import AppIntents
import Charts
import SwiftUI
import WidgetKit

#if canImport(UIKit)
  import UIKit
#else
  import AppKit
#endif

// Reads the totals-only snapshot the app writes after each portfolio update
// (`apps/tauri/src/widget.rs`). The widget never opens the database or goes online.
// Keep the group id and file name in step with WidgetSnapshotBridge.swift.
#if os(macOS)
  // Developer ID apps on macOS use a team-prefixed group.
  private let appGroupIdentifier = "DYDJ2RNL5H.com.teymz.wealthfolio"
#else
  private let appGroupIdentifier = "group.com.teymz.wealthfolio"
#endif
/// The app's own file: this extension's id is the app's plus ".widget".
private let snapshotFileName: String = {
  let own = Bundle.main.bundleIdentifier ?? "com.teymz.wealthfolio.widget"
  let app = own.hasSuffix(".widget") ? String(own.dropLast(".widget".count)) : own
  return "\(app).widget-snapshot.json"
}()
private let staleAfter: TimeInterval = 24 * 60 * 60
private let hiddenAmount = "••••••"

// MARK: - Snapshot

struct Snapshot: Decodable {
  struct Point: Decodable {
    let date: String
    let value: Double
  }

  struct Investments: Decodable {
    let total: Double
    let dayChange: Double?
    let dayChangePercent: Double?
    let history: [Point]
  }

  struct NetWorth: Decodable {
    let total: Double
    let change: Double?
    let changePercent: Double?
    let history: [Point]
  }

  struct Day: Decodable {
    let date: String
    let amount: Double?
  }

  struct Spending: Decodable {
    let spent: Double
    let days: [Day]
  }

  struct Holding: Decodable {
    let symbol: String
    let name: String?
    let dayChangePercent: Double?
    /// A base64 PNG.
    let logo: String?
  }

  static let supportedVersion = 3

  let version: Int
  let currency: String
  let gainColors: String
  let asOf: Date
  let investments: Investments?
  let netWorth: NetWorth?
  let spending: Spending?
  let topHoldings: [Holding]

  static func load() -> Snapshot? {
    guard
      let url = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
        .appendingPathComponent(snapshotFileName),
      let data = try? Data(contentsOf: url)
    else { return nil }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = formatter.date(from: text) { return date }
      formatter.formatOptions = [.withInternetDateTime]
      if let date = formatter.date(from: text) { return date }
      throw DecodingError.dataCorrupted(
        .init(codingPath: decoder.codingPath, debugDescription: "Unreadable date"))
    }
    guard let snapshot = try? decoder.decode(Snapshot.self, from: data),
      snapshot.version == supportedVersion
    else { return nil }
    return snapshot
  }

  /// Shown in the widget gallery only, never as real data.
  static let preview: Snapshot = {
    let wave: (Int) -> Double = { day in
      sin(Double(day) / 3.2) * 2_400 + Double(day) * 310 + (day % 5 == 0 ? -1_100 : 0)
    }
    let points = (0..<30).map { Point(date: "\($0)", value: 120_000 + wave($0)) }
    let worth = (0..<30).map { Point(date: "\($0)", value: 486_000 + wave($0) * 1.6) }
    let spent: [Double] = [
      42, 18, 0, 64, 22, 135, 12, 38, 0, 27, 51, 9, 76, 31, 0, 44, 23,
    ]
    let days = (0..<30).map { day in
      Day(date: "2026-11-\(String(format: "%02d", day + 1))", amount: day < spent.count ? spent[day] : nil)
    }
    return Snapshot(
      version: supportedVersion,
      currency: Locale.current.currency?.identifier ?? "USD",
      gainColors: "green-up",
      asOf: .now,
      investments: Investments(
        total: 128_450.32, dayChange: 612.4, dayChangePercent: 0.0048, history: points),
      netWorth: NetWorth(
        total: 512_830.18, change: 7_420.5, changePercent: 0.0147, history: worth),
      spending: Spending(spent: spent.reduce(0, +), days: days),
      topHoldings: [
        ("AAPL", "Apple", 0.0043), ("MSFT", "Microsoft", 0.0011), ("GOOG", "Alphabet", 0.0052),
        ("NVDA", "NVIDIA", 0.0187), ("AMZN", "Amazon", -0.0029), ("VTI", "Vanguard Total Stock", 0.0031),
      ].map { Holding(symbol: $0.0, name: $0.1, dayChangePercent: $0.2, logo: nil) }
    )
  }()
}

// MARK: - Palette (the app's Signature theme)

extension Color {
  fileprivate init(light: UInt32, dark: UInt32) {
    let component = { (hex: UInt32, shift: UInt32) in CGFloat((hex >> shift) & 0xFF) / 255 }
    #if os(macOS)
      self.init(
        nsColor: NSColor(name: nil) { appearance in
          let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
          return NSColor(
            srgbRed: component(hex, 16), green: component(hex, 8), blue: component(hex, 0),
            alpha: 1)
        })
    #else
      self.init(
        uiColor: UIColor { traits in
          let hex = traits.userInterfaceStyle == .dark ? dark : light
          return UIColor(
            red: component(hex, 16), green: component(hex, 8), blue: component(hex, 0), alpha: 1)
        })
    #endif
  }
}

/// The lock screen's rectangular widget, which exists only on iPhone.
private func isLockScreen(_ family: WidgetFamily) -> Bool {
  #if os(iOS)
    family == .accessoryRectangular
  #else
    false
  #endif
}

/// A decoded PNG as a SwiftUI image.
private func pngImage(_ data: Data) -> Image? {
  #if os(macOS)
    NSImage(data: data).map { Image(nsImage: $0) }
  #else
    UIImage(data: data).map { Image(uiImage: $0) }
  #endif
}

private enum Palette {
  static let background = Color(light: 0xFDFDFD, dark: 0x111113)
  static let foreground = Color(light: 0x121212, dark: 0xF4F4F5)
  static let muted = Color(light: 0x5C5C5C, dark: 0xA3A3A8)
  static let faint = Color(light: 0xE6E6E6, dark: 0x2A2A2E)
  static let success = Color(light: 0x357941, dark: 0x86C09C)
  static let destructive = Color(light: 0xB3261E, dark: 0xF08A7E)
  static let lossBlue = Color(light: 0x205EA6, dark: 0x66A0C8)
  static let netWorth = Color(light: 0xAA8C3E, dark: 0xD4B66A)
  static let spending = Color(light: 0x4F6B92, dark: 0x8EA6CF)
}

/// The app's "Gain and loss colours" setting.
private struct SignColors {
  let gain: Color
  let loss: Color

  init(_ setting: String) {
    switch setting {
    case "red-up":
      gain = Palette.destructive
      loss = Palette.success
    case "red-up-blue-down":
      gain = Palette.destructive
      loss = Palette.lossBlue
    default:
      gain = Palette.success
      loss = Palette.destructive
    }
  }

  func color(_ value: Double) -> Color { value < 0 ? loss : gain }
}

// MARK: - Formatting

private func money(_ value: Double, _ currency: String, fraction: Int = 2) -> String {
  value.formatted(.currency(code: currency).precision(.fractionLength(fraction)))
}

private func signedMoney(_ value: Double, _ currency: String) -> String {
  value.formatted(
    .currency(code: currency).precision(.fractionLength(0...2)).sign(strategy: .always()))
}

private func signedPercent(_ value: Double) -> String {
  value.formatted(.percent.precision(.fractionLength(2)).sign(strategy: .always()))
}

private let isoDay: DateFormatter = {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter
}()

// MARK: - Configuration and timeline

struct ConfigurationIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Wealthfolio"

  @Parameter(title: "Show balance", default: false)
  var showAmounts: Bool
}

struct Entry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?
  let showAmounts: Bool

  var isStale: Bool {
    guard let snapshot else { return false }
    return date.timeIntervalSince(snapshot.asOf) >= staleAfter
  }
}

struct Provider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> Entry {
    Entry(date: .now, snapshot: .preview, showAmounts: true)
  }

  func snapshot(for configuration: ConfigurationIntent, in context: Context) async -> Entry {
    let snapshot: Snapshot? = context.isPreview ? Snapshot.preview : Snapshot.load()
    return Entry(
      date: .now, snapshot: snapshot,
      showAmounts: context.isPreview || configuration.showAmounts)
  }

  func timeline(for configuration: ConfigurationIntent, in context: Context) async
    -> Timeline<Entry>
  {
    let now = Date.now
    let snapshot = Snapshot.load()
    var entries = [Entry(date: now, snapshot: snapshot, showAmounts: configuration.showAmounts)]
    // The app reloads the widget when it writes; this entry only turns the
    // widget to its stale state if no update arrives for a day.
    if let snapshot, snapshot.asOf.addingTimeInterval(staleAfter) > now {
      entries.append(
        Entry(
          date: snapshot.asOf.addingTimeInterval(staleAfter), snapshot: snapshot,
          showAmounts: configuration.showAmounts))
    }
    return Timeline(entries: entries, policy: .never)
  }
}

// MARK: - Building blocks

private struct SectionLabel: View {
  let title: LocalizedStringKey
  var period: LocalizedStringKey? = nil
  var color: Color = Palette.muted

  var body: some View {
    Group {
      if let period {
        Text(title) + Text(verbatim: " · ") + Text(period)
      } else {
        Text(title)
      }
    }
      .font(.system(size: 11, weight: .semibold))
      .tracking(0.6)
      .textCase(.uppercase)
      .foregroundStyle(color)
      .lineLimit(1)
      .minimumScaleFactor(0.75)
  }
}

/// A balance with its cents in the secondary colour, as in the app's header.
private struct Amount: View {
  let value: Double
  let currency: String
  let show: Bool
  var size: CGFloat = 24

  var body: some View {
    Group {
      if show {
        let text = money(value, currency)
        let separator = Locale.current.decimalSeparator ?? "."
        if let range = text.range(of: separator, options: .backwards) {
          Text(text[..<range.lowerBound]).foregroundStyle(Palette.foreground)
            + Text(text[range.lowerBound...]).foregroundStyle(Palette.muted)
        } else {
          Text(text).foregroundStyle(Palette.foreground)
        }
      } else {
        Text(hiddenAmount).foregroundStyle(Palette.foreground)
      }
    }
    .font(.system(size: size, weight: .semibold, design: .default))
    .monospacedDigit()
    .lineLimit(1)
    .minimumScaleFactor(0.45)
    .privacySensitive()
  }
}

/// A signed change: arrow, amount (hidden with the balance) and percent.
private struct Change: View {
  let amount: Double?
  let percent: Double?
  let currency: String
  let show: Bool
  let colors: SignColors
  var font: Font = .system(size: 12, weight: .medium)

  var body: some View {
    let direction = amount ?? percent ?? 0
    let color = colors.color(direction)
    HStack(spacing: 3) {
      Image(systemName: direction < 0 ? "arrow.down.right" : "arrow.up.right")
        .font(.system(size: 9, weight: .bold))
        .flipsForRightToLeftLayoutDirection(true)
      if let amount {
        Text(show ? signedMoney(amount, currency) : hiddenAmount).privacySensitive()
      }
      if let percent {
        Text(signedPercent(percent))
          .opacity(amount == nil ? 1 : 0.8)
      }
    }
    .font(font)
    .monospacedDigit()
    .foregroundStyle(color)
    .lineLimit(1)
    .minimumScaleFactor(0.6)
  }
}

private struct Pill: View {
  let text: String
  let color: Color

  var body: some View {
    Text(text)
      .font(.system(size: 11, weight: .semibold))
      .monospacedDigit()
      .foregroundStyle(color)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(color.opacity(0.14), in: Capsule())
      .lineLimit(1)
  }
}

/// The Dashboard chart: a line over a fading area.
private struct AreaLine: View {
  let points: [Snapshot.Point]
  let color: Color
  var lineWidth: CGFloat = 2

  var body: some View {
    let values = points.map(\.value)
    let low = values.min() ?? 0
    let high = values.max() ?? 0
    let pad = max((high - low) * 0.12, max(abs(high) * 0.001, 1))
    let floor = low - pad
    Chart(Array(points.enumerated()), id: \.offset) { index, point in
      AreaMark(
        x: .value("Day", index),
        yStart: .value("Floor", floor),
        yEnd: .value("Value", point.value)
      )
      .interpolationMethod(.catmullRom)
      .foregroundStyle(
        LinearGradient(
          colors: [color.opacity(0.32), color.opacity(0.10), color.opacity(0)],
          startPoint: .top, endPoint: .bottom))
      LineMark(x: .value("Day", index), y: .value("Value", point.value))
        .interpolationMethod(.catmullRom)
        .foregroundStyle(color)
        .lineStyle(StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
      if index == points.count - 1 {
        PointMark(x: .value("Day", index), y: .value("Value", point.value))
          .symbolSize(28)
          .foregroundStyle(color)
      }
    }
    .chartXAxis(.hidden)
    .chartYAxis(.hidden)
    .chartLegend(.hidden)
    // Room at the end so the last point's dot isn't cut by the widget's edge.
    .chartXScale(domain: 0...max(points.count - 1, 1), range: .plotDimension(endPadding: 6))
    .chartYScale(domain: floor...(high + pad))
    .accessibilityHidden(true)
  }
}

/// One bar per day of the month: spent days in the accent, today brightest,
/// days still to come as faint stubs.
private struct SpendingBars: View {
  let days: [Snapshot.Day]

  var body: some View {
    let largest = max(days.compactMap(\.amount).max() ?? 0, 1)
    let stub = largest * 0.045
    let todayIndex = days.lastIndex { $0.amount != nil } ?? -1
    Chart(Array(days.enumerated()), id: \.offset) { index, day in
      // A category per day, so `.ratio` widths have a band to fill.
      BarMark(
        x: .value("Day", day.date),
        yStart: .value("Base", 0),
        yEnd: .value("Spent", max(day.amount ?? 0, stub)),
        width: .ratio(0.62)
      )
      .cornerRadius(2)
      .foregroundStyle(
        day.amount == nil
          ? Palette.faint
          : (index == todayIndex ? Palette.spending : Palette.spending.opacity(0.55)))
    }
    .chartXAxis(.hidden)
    .chartYAxis(.hidden)
    .chartLegend(.hidden)
    .chartYScale(domain: 0...largest)
    .accessibilityHidden(true)
  }
}

private struct Message: View {
  let label: LocalizedStringKey
  let text: LocalizedStringKey
  var accent: Color = Palette.muted

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionLabel(title: label, color: accent)
      Spacer(minLength: 0)
      Text(text)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Palette.foreground)
        .lineLimit(4)
        .minimumScaleFactor(0.8)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .padding(14)
  }
}

private struct Footer: View {
  let entry: Entry
  let snapshot: Snapshot

  var body: some View {
    Group {
      if entry.isStale {
        Text("Open Wealthfolio to update.")
      } else {
        Text("Updated \(snapshot.asOf, style: .time)")
      }
    }
    .font(.system(size: 10, weight: .medium))
    .foregroundStyle(Palette.muted)
    .lineLimit(1)
  }
}

private struct Rectangular: View {
  let label: LocalizedStringKey
  let value: Double
  let currency: String
  let show: Bool
  let detail: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(label).font(.system(size: 11, weight: .semibold)).textCase(.uppercase)
        .widgetAccentable()
      Text(show ? money(value, currency, fraction: 0) : hiddenAmount)
        .font(.system(size: 17, weight: .semibold))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .privacySensitive()
      if let detail {
        Text(detail).font(.system(size: 12, weight: .medium)).monospacedDigit()
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - Investments and net worth

private struct TrendContent {
  let label: LocalizedStringKey
  let period: LocalizedStringKey
  let total: Double
  let change: Double?
  let percent: Double?
  let history: [Snapshot.Point]
  let lineColor: Color
}

private struct TrendView: View {
  @Environment(\.widgetFamily) private var family
  let entry: Entry
  let snapshot: Snapshot
  let content: TrendContent

  var body: some View {
    let colors = SignColors(snapshot.gainColors)
    switch family {
    case _ where isLockScreen(family):
      Rectangular(
        label: content.label, value: content.total, currency: snapshot.currency,
        show: entry.showAmounts, detail: content.percent.map(signedPercent))
    case .systemMedium:
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline) {
          SectionLabel(title: content.label)
          Spacer()
          Footer(entry: entry, snapshot: snapshot)
        }
        HStack(alignment: .lastTextBaseline, spacing: 8) {
          Amount(
            value: content.total, currency: snapshot.currency, show: entry.showAmounts, size: 28)
          Spacer(minLength: 0)
        }
        .padding(.top, 6)
        HStack(spacing: 6) {
          Change(
            amount: content.change, percent: content.percent, currency: snapshot.currency,
            show: entry.showAmounts, colors: colors)
          Text(content.period)
            .font(.system(size: 12))
            .foregroundStyle(Palette.muted)
            .lineLimit(1)
        }
        .padding(.top, 2)
        Spacer(minLength: 4)
        if content.history.count > 1 {
          AreaLine(points: content.history, color: content.lineColor)
            .frame(maxHeight: 54)
            .padding(.horizontal, -14)
            .padding(.bottom, -14)
        }
      }
      .padding(14)
    default:
      VStack(alignment: .leading, spacing: 0) {
        SectionLabel(title: content.label, period: content.period)
        Amount(value: content.total, currency: snapshot.currency, show: entry.showAmounts, size: 22)
          .padding(.top, 6)
        Group {
          if entry.isStale {
            Text("Open Wealthfolio to update.")
              .font(.system(size: 11, weight: .medium))
              .foregroundStyle(Palette.muted)
              .lineLimit(2)
          } else {
            HStack(spacing: 5) {
              if let percent = content.percent {
                Pill(text: signedPercent(percent), color: colors.color(percent))
              }
              if let change = content.change {
                Text(entry.showAmounts ? signedMoney(change, snapshot.currency) : hiddenAmount)
                  .foregroundStyle(colors.color(change))
                  .privacySensitive()
              }
            }
            .font(.system(size: 11, weight: .medium))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.6)
          }
        }
        .padding(.top, 2)
        Spacer(minLength: 2)
        if content.history.count > 1 {
          AreaLine(points: content.history, color: content.lineColor, lineWidth: 1.8)
            .frame(maxHeight: 46)
            .padding(.horizontal, -14)
            .padding(.bottom, -14)
        }
      }
      .padding(14)
    }
  }
}

struct InvestmentsWidgetView: View {
  let entry: Entry

  var body: some View {
    Group {
      if let snapshot = entry.snapshot, let section = snapshot.investments {
        TrendView(
          entry: entry, snapshot: snapshot,
          content: TrendContent(
            label: "Investments", period: "Today", total: section.total,
            change: section.dayChange, percent: section.dayChangePercent,
            history: section.history,
            lineColor: SignColors(snapshot.gainColors).gain))
      } else {
        NoDataView(label: "Investments", text: "Open Wealthfolio to see your portfolio.")
      }
    }
    .containerBackground(Palette.background, for: .widget)
  }
}

struct NetWorthWidgetView: View {
  let entry: Entry

  var body: some View {
    Group {
      if let snapshot = entry.snapshot, let section = snapshot.netWorth {
        TrendView(
          entry: entry, snapshot: snapshot,
          content: TrendContent(
            label: "Net Worth", period: "Past month", total: section.total,
            change: section.change, percent: section.changePercent,
            history: section.history, lineColor: Palette.netWorth))
      } else {
        NoDataView(label: "Net Worth", text: "Open Wealthfolio to see your portfolio.")
      }
    }
    .containerBackground(Palette.background, for: .widget)
  }
}

/// No data yet: a lock-screen line, or a short message on the home screen.
private struct NoDataView: View {
  @Environment(\.widgetFamily) private var family
  let label: LocalizedStringKey
  let text: LocalizedStringKey

  var body: some View {
    if isLockScreen(family) {
      VStack(alignment: .leading) {
        Text(label).font(.system(size: 11, weight: .semibold)).textCase(.uppercase)
        Text(text).font(.system(size: 12)).lineLimit(2)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      Message(label: label, text: text)
    }
  }
}

// MARK: - Spending

struct SpendingWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: Entry

  var body: some View {
    Group {
      if let snapshot = entry.snapshot, let section = snapshot.spending {
        content(snapshot: snapshot, section: section)
      } else if entry.snapshot != nil {
        NoDataView(label: "Spending", text: "Turn on spending tracking in Wealthfolio.")
      } else {
        NoDataView(label: "Spending", text: "Open Wealthfolio to see your portfolio.")
      }
    }
    .containerBackground(Palette.background, for: .widget)
  }

  private func monthName(_ section: Snapshot.Spending) -> String {
    guard let first = section.days.first, let date = isoDay.date(from: first.date) else {
      return ""
    }
    return date.formatted(.dateTime.month(.wide))
  }

  @ViewBuilder
  private func content(snapshot: Snapshot, section: Snapshot.Spending) -> some View {
    let today = section.days.last { $0.amount != nil }?.amount
    switch family {
    case _ where isLockScreen(family):
      Rectangular(
        label: "Spending", value: section.spent, currency: snapshot.currency,
        show: entry.showAmounts, detail: monthName(section))
    case .systemMedium:
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline) {
          SectionLabel(title: "Spending")
          Text(monthName(section))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Palette.spending)
            .textCase(.uppercase)
          Spacer()
          Footer(entry: entry, snapshot: snapshot)
        }
        HStack(alignment: .lastTextBaseline) {
          Amount(
            value: section.spent, currency: snapshot.currency, show: entry.showAmounts, size: 28)
          Spacer(minLength: 8)
          if let today {
            VStack(alignment: .trailing, spacing: 1) {
              Text("Today")
                .font(.system(size: 10, weight: .semibold))
                .textCase(.uppercase)
                .foregroundStyle(Palette.muted)
              Text(entry.showAmounts ? money(today, snapshot.currency) : hiddenAmount)
                .font(.system(size: 13, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(Palette.spending)
                .privacySensitive()
            }
          }
        }
        .padding(.top, 6)
        Spacer(minLength: 8)
        SpendingBars(days: section.days)
          .frame(maxHeight: 50)
      }
      .padding(14)
    default:
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
          SectionLabel(title: "Spending")
          Spacer(minLength: 0)
          Text(monthName(section))
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Palette.spending)
            .textCase(.uppercase)
            .lineLimit(1)
        }
        Amount(value: section.spent, currency: snapshot.currency, show: entry.showAmounts, size: 22)
          .padding(.top, 8)
        Group {
          if entry.isStale {
            Text("Open Wealthfolio to update.").lineLimit(2)
          } else {
            Text("This month")
          }
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Palette.muted)
        .padding(.top, 2)
        Spacer(minLength: 6)
        SpendingBars(days: section.days)
          .frame(maxHeight: 40)
      }
      .padding(14)
    }
  }
}

// MARK: - Top holdings

/// The holding's logo, or its initials on a tile as the app's avatar shows them.
private struct HoldingLogo: View {
  let holding: Snapshot.Holding
  var size: CGFloat = 28

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
    Group {
      if let logo = holding.logo, let data = Data(base64Encoded: logo),
        let image = pngImage(data)
      {
        image
          .resizable()
          .interpolation(.high)
          .aspectRatio(contentMode: .fit)
          .background(Color.white)
      } else {
        Text(String(holding.symbol.prefix(4)))
          .font(.system(size: size * 0.3, weight: .bold))
          .foregroundStyle(Palette.muted)
          .minimumScaleFactor(0.5)
          .padding(2)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Palette.faint)
      }
    }
    .frame(width: size, height: size)
    .clipShape(shape)
    .overlay(shape.strokeBorder(Palette.faint, lineWidth: 1))
    .accessibilityHidden(true)
  }
}

private struct HoldingChange: View {
  let percent: Double?
  let colors: SignColors
  var size: CGFloat = 13

  var body: some View {
    let color = percent.map(colors.color) ?? Palette.muted
    Text(percent.map(signedPercent) ?? "–")
      .font(.system(size: size, weight: .semibold))
      .monospacedDigit()
      .foregroundStyle(color)
      .lineLimit(1)
      .padding(.horizontal, 6)
      .padding(.vertical, 4)
      .background(color.opacity(0.13), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      // The symbol gives way first; the change is never cut.
      .fixedSize()
  }
}

private struct HoldingRow: View {
  let holding: Snapshot.Holding
  let colors: SignColors
  var showName = false
  var logoSize: CGFloat = 28
  var changeSize: CGFloat = 13

  var body: some View {
    HStack(spacing: 8) {
      HoldingLogo(holding: holding, size: logoSize)
      VStack(alignment: .leading, spacing: 0) {
        Text(holding.symbol)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(Palette.foreground)
        if showName, let name = holding.name {
          Text(name)
            .font(.system(size: 11))
            .foregroundStyle(Palette.muted)
        }
      }
      .lineLimit(1)
      .minimumScaleFactor(0.7)
      Spacer(minLength: 4)
      HoldingChange(percent: holding.dayChangePercent, colors: colors, size: changeSize)
    }
  }
}

struct TopHoldingsWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: Entry

  var body: some View {
    Group {
      if let snapshot = entry.snapshot, !snapshot.topHoldings.isEmpty {
        content(snapshot: snapshot, holdings: snapshot.topHoldings)
      } else {
        NoDataView(label: "Top Holdings", text: "Open Wealthfolio to see your portfolio.")
      }
    }
    .containerBackground(Palette.background, for: .widget)
  }

  @ViewBuilder
  private func content(snapshot: Snapshot, holdings: [Snapshot.Holding]) -> some View {
    let colors = SignColors(snapshot.gainColors)
    switch family {
    case .systemMedium:
      // Two columns of three, filled down each column like a ranked list.
      let columns = [Array(holdings.prefix(3)), Array(holdings.dropFirst(3).prefix(3))]
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .top, spacing: 16) {
          ForEach(columns.indices, id: \.self) { column in
            // Equal-height rows spread the three evenly down the widget.
            VStack(spacing: 0) {
              ForEach(columns[column].indices, id: \.self) { row in
                HoldingRow(holding: columns[column][row], colors: colors, logoSize: 26, changeSize: 12)
                  .frame(maxHeight: .infinity)
              }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
          }
        }
        if entry.isStale {
          Footer(entry: entry, snapshot: snapshot)
        }
      }
      .padding(16)
    case .systemLarge:
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline) {
          SectionLabel(title: "Top Holdings", period: "Today")
          Spacer()
          Footer(entry: entry, snapshot: snapshot)
        }
        .padding(.bottom, 10)
        ForEach(holdings.indices, id: \.self) { index in
          if index > 0 {
            Divider().overlay(Palette.faint).padding(.vertical, 7)
          }
          HoldingRow(holding: holdings[index], colors: colors, showName: true, logoSize: 34)
        }
        Spacer(minLength: 0)
      }
      .padding(16)
    default:
      VStack(alignment: .leading, spacing: 9) {
        SectionLabel(title: "Top Holdings")
        VStack(spacing: 0) {
          ForEach(Array(holdings.prefix(3)).indices, id: \.self) { index in
            HoldingRow(holding: holdings[index], colors: colors, logoSize: 24, changeSize: 12)
              .frame(maxHeight: .infinity)
          }
        }
        if entry.isStale {
          Footer(entry: entry, snapshot: snapshot)
        }
      }
      .padding(14)
    }
  }
}

// MARK: - Widgets

#if os(macOS)
  // The Mac has no lock screen widgets.
  private let families: [WidgetFamily] = [.systemSmall, .systemMedium]
#else
  private let families: [WidgetFamily] = [.systemSmall, .systemMedium, .accessoryRectangular]
#endif

struct InvestmentsWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: "com.teymz.wealthfolio.portfolio", intent: ConfigurationIntent.self,
      provider: Provider()
    ) { entry in
      InvestmentsWidgetView(entry: entry)
    }
    .configurationDisplayName("Investments")
    .description("Your investments total and today's change.")
    .supportedFamilies(families)
    .contentMarginsDisabled()
  }
}

struct NetWorthWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: "com.teymz.wealthfolio.net-worth", intent: ConfigurationIntent.self,
      provider: Provider()
    ) { entry in
      NetWorthWidgetView(entry: entry)
    }
    .configurationDisplayName("Net Worth")
    .description("Your net worth over the past month.")
    .supportedFamilies(families)
    .contentMarginsDisabled()
  }
}

struct SpendingWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: "com.teymz.wealthfolio.spending", intent: ConfigurationIntent.self,
      provider: Provider()
    ) { entry in
      SpendingWidgetView(entry: entry)
    }
    .configurationDisplayName("Spending")
    .description("What you've spent this month.")
    .supportedFamilies(families)
    .contentMarginsDisabled()
  }
}

struct TopHoldingsWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: "com.teymz.wealthfolio.top-holdings", intent: ConfigurationIntent.self,
      provider: Provider()
    ) { entry in
      TopHoldingsWidgetView(entry: entry)
    }
    .configurationDisplayName("Top Holdings")
    .description("Your largest holdings and today's change.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    .contentMarginsDisabled()
  }
}

@main
struct WealthfolioWidgetBundle: WidgetBundle {
  var body: some Widget {
    InvestmentsWidget()
    NetWorthWidget()
    SpendingWidget()
    TopHoldingsWidget()
  }
}
