use worker::*;

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    // Get the URL from the request
    let url = req.url()?;
    
    // Create a JSON response
    let data = serde_json::json!({
        "message": "Hello from Rust Worker!",
        "service": "rust-worker-template",
        "url": url.to_string(),
        "timestamp": chrono::Utc::now().to_rfc3339()
    });
    
    // Return the response
    Response::from_json(&data)
}