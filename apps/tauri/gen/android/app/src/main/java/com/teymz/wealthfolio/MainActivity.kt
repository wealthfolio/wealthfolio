package com.teymz.wealthfolio

import android.content.res.Configuration
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  // The navigation bar's height (gesture handle or buttons), in CSS pixels.
  @Volatile private var navigationBarInset = 0f

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Edge-to-edge draws the page under the navigation bar, yet the WebView (133 here)
    // reports no bottom safe area for it. Track the bar's height and let the page read
    // it, so the tab bar can pad itself above the bar. Read the insets after layout
    // rather than with an insets listener: that would replace the WebView's own, which
    // gives the page its top safe area.
    webView.viewTreeObserver.addOnGlobalLayoutListener {
      ViewCompat.getRootWindowInsets(webView)?.let { insets ->
        navigationBarInset =
          insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom /
            resources.displayMetrics.density
      }
    }
    webView.addJavascriptInterface(NavigationBarInsets(), "WealthfolioAndroid")
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

  private inner class NavigationBarInsets {
    @JavascriptInterface fun navigationBarInset(): Float = navigationBarInset
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
