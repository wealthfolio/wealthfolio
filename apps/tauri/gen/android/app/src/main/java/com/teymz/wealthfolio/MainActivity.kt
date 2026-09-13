package com.teymz.wealthfolio

import android.os.Bundle
import android.content.Context
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private external fun initializeSecretStoreContext(context: Context)

  override fun onCreate(savedInstanceState: Bundle?) {
    System.loadLibrary("wealthfolio_app_lib")
    initializeSecretStoreContext(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
