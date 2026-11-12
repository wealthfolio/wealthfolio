import Foundation

#if canImport(FoundationModels)
import FoundationModels

/// Turns a tool's JSON Schema into the schema the on-device model generates
/// arguments from. Covers what the assistant's tools declare: objects, arrays,
/// string enums, the scalar types and nullable unions.
@available(macOS 26.0, iOS 26.0, *)
struct ToolSchemaConverter {
    /// Object and enum schemas need a name; nested ones get the path to them.
    static func schema(for parameters: [String: Any], toolName: String) throws -> GenerationSchema {
        let root = convert(parameters, name: toolName, forceObject: true)
        return try GenerationSchema(root: root, dependencies: [])
    }

    private static func convert(
        _ schema: [String: Any], name: String, forceObject: Bool = false
    ) -> DynamicGenerationSchema {
        let description = schema["description"] as? String

        if let values = schema["enum"] as? [Any] {
            let choices = values.compactMap { $0 as? String }
            if !choices.isEmpty {
                return DynamicGenerationSchema(name: name, description: description, anyOf: choices)
            }
        }

        // `anyOf: [X, null]` is how an optional value is often written.
        for key in ["anyOf", "oneOf"] {
            guard let options = schema[key] as? [[String: Any]] else { continue }
            let present = options.filter { typeName(of: $0) != "null" }
            if present.count == 1, let only = present.first {
                return convert(only, name: name)
            }
            if !present.isEmpty {
                let choices = present.enumerated().map { index, option in
                    convert(option, name: "\(name)_\(index)")
                }
                return DynamicGenerationSchema(name: name, description: description, anyOf: choices)
            }
        }

        switch typeName(of: schema) ?? (forceObject || schema["properties"] != nil ? "object" : "string") {
        case "object":
            let required = Set((schema["required"] as? [String]) ?? [])
            let fields = (schema["properties"] as? [String: Any]) ?? [:]
            // The model writes fields in this order, so it follows the tool's
            // own order, which the app sends as `x-wf-order` (a JSON object
            // has none once parsed here). Sorted without it, so the schema is
            // the same on every request.
            let declared = ((schema["x-wf-order"] as? [String]) ?? []).filter { fields[$0] != nil }
            let order = declared + fields.keys.filter { !declared.contains($0) }.sorted()
            let properties = order.compactMap { key -> DynamicGenerationSchema.Property? in
                guard let field = fields[key] as? [String: Any] else { return nil }
                return DynamicGenerationSchema.Property(
                    name: key,
                    description: field["description"] as? String,
                    schema: convert(field, name: "\(name)_\(key)"),
                    isOptional: !required.contains(key))
            }
            return DynamicGenerationSchema(name: name, description: description, properties: properties)
        case "array":
            let items = (schema["items"] as? [String: Any]) ?? [:]
            return DynamicGenerationSchema(
                arrayOf: convert(items, name: "\(name)_item"),
                minimumElements: schema["minItems"] as? Int,
                maximumElements: schema["maxItems"] as? Int)
        case "integer":
            return DynamicGenerationSchema(type: Int.self)
        case "number":
            return DynamicGenerationSchema(type: Double.self)
        case "boolean":
            return DynamicGenerationSchema(type: Bool.self)
        default:
            return DynamicGenerationSchema(type: String.self)
        }
    }

    /// The schema's type, reading `["string", "null"]` as `string`.
    private static func typeName(of schema: [String: Any]) -> String? {
        if let name = schema["type"] as? String { return name }
        if let names = schema["type"] as? [String] {
            return names.first { $0 != "null" } ?? names.first
        }
        return nil
    }
}
#endif
