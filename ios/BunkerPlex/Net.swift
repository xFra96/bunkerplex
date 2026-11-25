import Foundation

/// Il server di casa: indirizzi, /api/info e ricerca sulla rete locale
/// (come Net.kt dell'app Android).
enum Net {
    static let port = 32500

    /// Una GET sincrona (da chiamare fuori dal thread principale).
    static func get(_ url: String, timeout: TimeInterval) -> (Int, Data)? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.setValue("BunkerPlex", forHTTPHeaderField: "User-Agent")
        return send(req)
    }

    static func send(_ req: URLRequest) -> (Int, Data)? {
        let sem = DispatchSemaphore(value: 0)
        var out: (Int, Data)?
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = req.timeoutInterval
        cfg.timeoutIntervalForResource = req.timeoutInterval + 5
        let session = URLSession(configuration: cfg)
        session.dataTask(with: req) { data, resp, _ in
            if let r = resp as? HTTPURLResponse { out = (r.statusCode, data ?? Data()) }
            sem.signal()
        }.resume()
        sem.wait()
        session.finishTasksAndInvalidate()
        return out
    }

    /// Le informazioni del server, o nil se a quell'indirizzo non risponde BunkerPlex.
    static func info(_ base: String, timeout: TimeInterval) -> [String: Any]? {
        guard let (code, data) = get(base + "/api/info", timeout: timeout), code < 400,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              obj["app"] as? String == "bunkerplex" else { return nil }
        return obj
    }

    /// "192.168.1.20" -> "http://192.168.1.20:32500"
    static func normalize(_ input: String) -> String {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") { s = "http://" + s }
        let host = s.components(separatedBy: "://").last ?? ""
        if !host.contains(":") { s += ":\(port)" }
        return s
    }

    /// I primi tre numeri degli indirizzi IPv4 privati del telefono (Wi-Fi), es. "192.168.1".
    static func localPrefixes() -> [String] {
        var out: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return [] }
        defer { freeifaddrs(ifaddr) }
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = p {
            let ifa = cur.pointee
            p = ifa.ifa_next
            guard let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: ifa.ifa_name)
            guard name.hasPrefix("en") || name.hasPrefix("bridge") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: host)
                let parts = ip.split(separator: ".").compactMap { Int($0) }
                guard parts.count == 4 else { continue }
                let priv = parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) ||
                    (parts[0] == 192 && parts[1] == 168)
                if priv { out.append(parts[0...2].map(String.init).joined(separator: ".")) }
            }
        }
        var seen = Set<String>()
        return out.filter { seen.insert($0).inserted }
    }

    /// Cerca il server sulla rete di casa provando tutti gli indirizzi vicini.
    static func discover() -> String? {
        let prefixes = localPrefixes()
        if prefixes.isEmpty { return nil }
        let lock = NSLock()
        var found: String?
        let group = DispatchGroup()
        let queue = DispatchQueue(label: "discover", attributes: .concurrent)
        let limit = DispatchSemaphore(value: 48)
        for prefix in prefixes {
            for i in 1...254 {
                group.enter()
                queue.async {
                    limit.wait()
                    defer { limit.signal(); group.leave() }
                    lock.lock(); let done = found != nil; lock.unlock()
                    if done { return }
                    let url = "http://\(prefix).\(i):\(port)"
                    if info(url, timeout: 1.5) != nil {
                        lock.lock(); if found == nil { found = url }; lock.unlock()
                    }
                }
            }
        }
        _ = group.wait(timeout: .now() + 30)
        lock.lock(); defer { lock.unlock() }
        return found
    }
}
