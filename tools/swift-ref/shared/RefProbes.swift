// Platform probes: how Foundation on the CI runner (macOS 15, Xcode 16.4) behaves where the
// TypeScript port has to choose between two plausible readings. Written to
// golden/reference-meta/<brand>/probes.json.
import Foundation

@MainActor
func refProbes() -> RefJSON {
    // 1. Decimal → Double: correctly rounded, or swift-foundation's word-by-word ÷10 algorithm?
    let decimals = ["0.07", "0.1", "0.3", "1.1", "2.675", "1.0842", "151.42", "33.1", "123.45", "-30", "-0.07",
                    "999999999999.99", "0.000001", "1e-7", "1.0000000000000002", "12345678901234567890.123"]
    let decimalRows: [RefJSON] = decimals.map { text in
        let d = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")) ?? 0
        let viaNS = NSDecimalNumber(decimal: d).doubleValue
        let viaTruncating = Double(truncating: d as NSNumber)
        let parsed = Double(text) ?? .nan
        return .object([
            ("text", .string(text)),
            ("decimalDescription", .string(d.description)),
            ("nsDecimalNumberDoubleValue", refDouble(viaNS)),
            ("nsDecimalNumberBits", .string(String(viaNS.bitPattern, radix: 16))),
            ("doubleTruncating", refDouble(viaTruncating)),
            ("doubleFromText", refDouble(parsed)),
            ("doubleFromTextBits", .string(String(parsed.bitPattern, radix: 16))),
            ("equalsCorrectlyRounded", .bool(viaNS == parsed)),
        ])
    }

    // 2. DST: skipped and repeated wall-clock times, read the two ways the apps read local times.
    let cases: [(zone: String, text: String, kind: String)] = [
        ("America/New_York", "2026-03-08 02:30:00", "skipped"),
        ("America/New_York", "2026-11-01 01:30:00", "repeated"),
        ("Europe/Berlin", "2026-03-29 02:30:00", "skipped"),
        ("Europe/Berlin", "2026-10-25 02:30:00", "repeated"),
        ("America/New_York", "2026-03-08 00:00:00", "start of a 23-hour day"),
        ("America/New_York", "2026-11-01 00:00:00", "start of a 25-hour day"),
    ]
    let dstRows: [RefJSON] = cases.map { c in
        let tz = TimeZone(identifier: c.zone) ?? .gmt
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = tz
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let viaFormatter = formatter.date(from: c.text)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        let parts = c.text.split(whereSeparator: { $0 == "-" || $0 == " " || $0 == ":" }).compactMap { Int($0) }
        var comps = DateComponents()
        if parts.count == 6 {
            comps.year = parts[0]; comps.month = parts[1]; comps.day = parts[2]
            comps.hour = parts[3]; comps.minute = parts[4]; comps.second = parts[5]
        }
        let viaCalendar = cal.date(from: comps)
        @MainActor func row(_ d: Date?) -> RefJSON {
            guard let d else { return .null }
            return .object([("utc", .string(RefFormat.iso.string(from: d))),
                            ("offsetSeconds", .int(Int64(tz.secondsFromGMT(for: d))))])
        }
        var obj: [(String, RefJSON)] = [
            ("zone", .string(c.zone)), ("wallTime", .string(c.text)), ("kind", .string(c.kind)),
            ("dateFormatter", row(viaFormatter)), ("calendarDateFromComponents", row(viaCalendar)),
        ]
        if let start = viaCalendar {
            let dayStart = cal.startOfDay(for: start)
            let next = cal.date(byAdding: .day, value: 1, to: dayStart)
            obj.append(("startOfDay", row(dayStart)))
            obj.append(("dayLengthHours", next.map { refDouble($0.timeIntervalSince(dayStart) / 3600) } ?? .null))
        }
        return .object(obj)
    }

    return .object([
        ("decimalToDouble", .array(decimalRows)),
        ("dst", .array(dstRows)),
        ("brand", refBrandProbes()),
        ("environment", .object([
            ("tz", .string(TimeZone.current.identifier)),
            ("locale", .string(Locale.current.identifier)),
            ("firstWeekday", .int(Int64(Calendar.current.firstWeekday))),
            ("minimumDaysInFirstWeek", .int(Int64(Calendar.current.minimumDaysInFirstWeek))),
            ("operatingSystem", .string(ProcessInfo.processInfo.operatingSystemVersionString)),
        ])),
    ])
}
