package com.teymz.wealthfolio

import android.content.res.Configuration
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // The WebView would enlarge text by Android's font size on its own, leaving
    // icons, spacing and controls at their size, and the app's Text size setting
    // would then multiply it. Hand the app the scale instead: until a size is
    // picked, it starts at the one nearest to Android's (src/themes/text-size.ts).
    webView.settings.textZoom = 100
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      val scale = resources.configuration.fontScale
      // Only the app's own pages; addon frames have an opaque origin.
      WebViewCompat.addDocumentStartJavaScript(
        webView,
        "window.wealthfolioSystemTextScale = $scale;",
        setOf("http://tauri.localhost", "https://tauri.localhost"),
      )
    }
  }

  override fun onPause() {
    window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
    super.onPause()
  }

  override fun onResume() {
    super.onResume()
    window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // The manifest handles uiMode changes without recreating the activity, so
    // re-apply edge-to-edge to give the system bar icons the new light/dark mode.
    enableEdgeToEdge()
  }
}
