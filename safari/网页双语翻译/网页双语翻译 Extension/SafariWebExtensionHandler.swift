//
//  SafariWebExtensionHandler.swift
//  网页双语翻译 Extension
//
//  Created by sūn on 6/6/26.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received native message (profile: %@)", profile?.uuidString ?? "none")

        guard
            let requestMessage = message as? [String: Any],
            requestMessage["type"] as? String == "HTTP_REQUEST"
        else {
            complete(context, message: ["ok": false, "error": "不支持的原生请求"])
            return
        }

        performHTTPRequest(requestMessage, context: context)
    }

    private func performHTTPRequest(
        _ message: [String: Any],
        context: NSExtensionContext
    ) {
        guard
            let urlString = message["url"] as? String,
            let url = URL(string: urlString),
            isAllowed(url)
        else {
            complete(context, message: ["ok": false, "error": "不允许的 API 地址"])
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = message["method"] as? String ?? "POST"
        request.timeoutInterval = 120

        if let headers = message["headers"] as? [String: String] {
            for (name, value) in headers {
                request.setValue(value, forHTTPHeaderField: name)
            }
        } else if let headers = message["headers"] as? [String: Any] {
            for (name, value) in headers {
                request.setValue(String(describing: value), forHTTPHeaderField: name)
            }
        }

        if let body = message["body"] as? String {
            request.httpBody = body.data(using: .utf8)
        }

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                self.complete(
                    context,
                    message: ["ok": false, "error": error.localizedDescription]
                )
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                self.complete(
                    context,
                    message: ["ok": false, "error": "翻译服务未返回 HTTP 响应"]
                )
                return
            }

            let payload: Any
            if let data, !data.isEmpty {
                payload = (try? JSONSerialization.jsonObject(with: data)) ??
                    String(data: data, encoding: .utf8) ??
                    ""
            } else {
                payload = [:]
            }

            self.complete(
                context,
                message: [
                    "ok": (200..<300).contains(httpResponse.statusCode),
                    "status": httpResponse.statusCode,
                    "payload": payload
                ]
            )
        }.resume()
    }

    private func isAllowed(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased() else {
            return false
        }

        if scheme == "https" && host == "api.deepseek.com" {
            return true
        }

        return scheme == "http" &&
            (host == "127.0.0.1" || host == "localhost")
    }

    private func complete(
        _ context: NSExtensionContext,
        message: [String: Any]
    ) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: message]
        } else {
            response.userInfo = ["message": message]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

}
