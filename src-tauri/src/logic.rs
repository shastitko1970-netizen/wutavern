use serde_json::{json, Value};
use uuid::Uuid;

pub const SECRET_KEY: &str = "api_key_custom";
pub const SECRET_LABEL: &str = "WuApi";
pub const DEFAULT_BASE: &str = "https://eco.wuproj.com/v1";
pub const DEFAULT_PORT: u16 = 8000;

pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Адрес WuApi пустой".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Адрес WuApi должен начинаться с http:// или https://".into());
    }
    if trimmed.chars().any(|c| c.is_whitespace()) {
        return Err("В адресе WuApi не должно быть пробелов".into());
    }
    let mut url = trimmed.trim_end_matches('/').to_string();
    let tail = "/chat/completions";
    if url.to_ascii_lowercase().ends_with(tail) {
        url.truncate(url.len() - tail.len());
        url = url.trim_end_matches('/').to_string();
    }
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Адрес WuApi не разбирается".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Адрес WuApi не должен содержать логин и пароль".into());
    }
    if parsed.host_str().is_none() {
        return Err("В адресе WuApi нет хоста".into());
    }
    Ok(url)
}

pub fn validate_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Ключ WuApi пустой".into());
    }
    if key.chars().any(|c| c == '\n' || c == '\r') {
        return Err("Ключ WuApi должен быть одной строкой".into());
    }
    if key.chars().count() > 512 {
        return Err("Ключ WuApi слишком длинный".into());
    }
    Ok(key.to_string())
}

pub fn validate_port(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("Порт должен быть от 1 до 65535".into());
    }
    Ok(())
}

pub fn key_hint(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return "не задан".into();
    }
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 4 {
        return "задан".into();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("…{tail}")
}

pub fn redact(text: &str, secret: &str) -> String {
    if secret.trim().len() < 4 {
        return text.to_string();
    }
    text.replace(secret.trim(), "[redacted]")
}

pub fn yaml_scalar(text: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in text.lines() {
        let indent = line.bytes().take_while(|b| *b == b' ' || *b == b'\t').count();
        let trimmed = &line[indent..];
        let Some(rest) = trimmed.strip_prefix(&prefix) else {
            continue;
        };
        let mut value = rest.trim();
        if let Some(hash) = value.find('#') {
            if hash == 0 || value.as_bytes().get(hash - 1) == Some(&b' ') {
                value = value[..hash].trim();
            }
        }
        if value.is_empty() {
            return None;
        }
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = &value[1..value.len() - 1];
        }
        return Some(value.to_string());
    }
    None
}

pub fn accounts_enabled(config: &str) -> bool {
    yaml_scalar(config, "enableUserAccounts").as_deref() == Some("true")
}

pub fn set_yaml_port(text: &str, port: u16) -> String {
    let mut found = false;
    let mut out = String::new();
    for line in text.split_inclusive('\n') {
        let newline = line.ends_with('\n');
        let body = line.trim_end_matches(['\r', '\n']);
        let indent_len = body.bytes().take_while(|b| *b == b' ' || *b == b'\t').count();
        let trimmed = &body[indent_len..];
        if let Some(rest) = trimmed.strip_prefix("port:") {
            let head = rest.trim().split('#').next().unwrap_or("").trim();
            if !head.is_empty() && head.bytes().all(|b| b.is_ascii_digit()) {
                found = true;
                out.push_str(&body[..indent_len]);
                out.push_str(&format!("port: {port}"));
                if newline {
                    out.push('\n');
                }
                continue;
            }
        }
        out.push_str(body);
        if newline {
            out.push('\n');
        }
    }
    if !found {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("port: {port}\n"));
    }
    out
}

pub fn normalize_secrets(secrets: Value) -> Value {
    let Value::Object(map) = &secrets else {
        return secrets;
    };
    let has_array = map.values().any(Value::is_array);
    let has_string = map.values().any(Value::is_string);
    if !has_string || has_array || map.contains_key("_migrated") {
        return secrets;
    }
    let mut migrated = serde_json::Map::new();
    migrated.insert("_migrated".into(), json!([]));
    for (key, value) in map {
        if let Some(text) = value.as_str() {
            if text.trim().is_empty() {
                continue;
            }
            migrated.insert(
                key.clone(),
                json!([{
                    "id": Uuid::new_v4().to_string(),
                    "value": text,
                    "label": key,
                    "active": true
                }]),
            );
        }
    }
    Value::Object(migrated)
}

pub fn upsert_secret(secrets: &mut Value, key_value: &str) -> String {
    if !secrets.is_object() {
        *secrets = json!({});
    }
    let current = secrets.get(SECRET_KEY).cloned().unwrap_or_else(|| json!([]));
    let mut list = match current {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    let mut found: Option<String> = None;
    for entry in &mut list {
        if !entry.is_object() {
            continue;
        }
        let same = entry.get("value").and_then(Value::as_str) == Some(key_value);
        if same {
            entry["active"] = json!(true);
            let label = entry.get("label").and_then(Value::as_str).unwrap_or("");
            if label.is_empty() {
                entry["label"] = json!(SECRET_LABEL);
            }
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                found = Some(id.to_string());
            } else {
                let id = Uuid::new_v4().to_string();
                entry["id"] = json!(id.clone());
                found = Some(id);
            }
        } else {
            entry["active"] = json!(false);
        }
    }
    let id = match found {
        Some(id) => id,
        None => {
            let id = Uuid::new_v4().to_string();
            list.push(json!({
                "id": id,
                "value": key_value,
                "label": SECRET_LABEL,
                "active": true
            }));
            id
        }
    };
    secrets[SECRET_KEY] = Value::Array(list);
    id
}

pub fn active_secret<'a>(secrets: &'a Value) -> Option<&'a str> {
    let list = secrets.get(SECRET_KEY)?.as_array()?;
    list.iter().find_map(|entry| {
        if entry.get("active").and_then(Value::as_bool) == Some(true) {
            entry.get("value").and_then(Value::as_str)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_completions_suffix_and_slash() {
        assert_eq!(
            normalize_base_url("https://eco.wuproj.com/v1/chat/completions/").unwrap(),
            "https://eco.wuproj.com/v1"
        );
        assert_eq!(
            normalize_base_url("https://eco.wuproj.com/v1/").unwrap(),
            "https://eco.wuproj.com/v1"
        );
    }

    #[test]
    fn rejects_bad_urls() {
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("eco.wuproj.com/v1").is_err());
        assert!(normalize_base_url("https://user:pw@eco.wuproj.com/v1").is_err());
        assert!(normalize_base_url("https://eco.wuproj.com/v1 extra").is_err());
    }

    #[test]
    fn rewrites_only_the_port_line() {
        let text = "# head\r\nport: 8000 # keep\r\ndataRoot: ./data\r\n";
        let next = set_yaml_port(text, 9000);
        assert!(next.contains("port: 9000"));
        assert!(!next.contains("port: 8000"));
        assert!(next.contains("dataRoot: ./data"));
        assert_eq!(yaml_scalar(&next, "port").as_deref(), Some("9000"));
        assert_eq!(yaml_scalar(&next, "dataRoot").as_deref(), Some("./data"));
    }

    #[test]
    fn appends_port_when_missing() {
        let next = set_yaml_port("dataRoot: ./data\n", 8000);
        assert!(next.contains("port: 8000"));
        assert!(next.contains("dataRoot: ./data"));
    }

    #[test]
    fn upsert_keeps_one_active_key() {
        let mut secrets = json!({
            "api_key_custom": [
                {"id": "old", "value": "previous-key", "label": "WuApi", "active": true}
            ]
        });
        let id = upsert_secret(&mut secrets, "next-key-value");
        let list = secrets["api_key_custom"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["active"], json!(false));
        assert_eq!(list[1]["active"], json!(true));
        assert_eq!(list[1]["id"], json!(id));
        assert_eq!(active_secret(&secrets), Some("next-key-value"));
        let again = upsert_secret(&mut secrets, "next-key-value");
        assert_eq!(again, id);
        assert_eq!(secrets["api_key_custom"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn hint_and_redact_hide_the_key() {
        assert_eq!(key_hint("wu-secret-abcd"), "…abcd");
        assert_eq!(key_hint(""), "не задан");
        assert_eq!(
            redact("wrote wu-secret-abcd into file", "wu-secret-abcd"),
            "wrote [redacted] into file"
        );
    }
}
