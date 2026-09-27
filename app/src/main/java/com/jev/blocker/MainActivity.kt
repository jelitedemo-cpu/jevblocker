package com.jev.blocker

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.jev.blocker.data.BlocklistStore
import com.jev.blocker.data.DomainSet
import com.jev.blocker.data.Stats
import com.jev.blocker.databinding.ActivityMainBinding
import com.jev.blocker.vpn.JevVpnService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var store: BlocklistStore

    private val handler = Handler(Looper.getMainLooper())
    private var suppressToggle = false
    private var domainCount = 0

    private val statsTicker = object : Runnable {
        override fun run() {
            renderStats()
            handler.postDelayed(this, 1_000L)
        }
    }

    private val vpnPermission = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            JevVpnService.start(this)
            setToggle(true)
        } else {
            setToggle(false)
            showMessage(getString(R.string.err_no_vpn_permission))
        }
    }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        store = BlocklistStore(applicationContext)

        binding.toggleSwitch.setOnCheckedChangeListener { _, checked ->
            if (suppressToggle) return@setOnCheckedChangeListener
            if (checked) requestStart() else JevVpnService.stop(this)
        }

        binding.updateButton.setOnClickListener { runUpdate() }
        binding.reloadButton.setOnClickListener { runReload() }

        lifecycleScope.launch {
            domainCount = withContext(Dispatchers.IO) { store.ensureSeeded() }
            renderStats()
        }
    }

    override fun onResume() {
        super.onResume()
        setToggle(JevVpnService.isRunning)
        handler.post(statsTicker)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(statsTicker)
    }

    private fun requestStart() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        val consent = VpnService.prepare(this)
        if (consent != null) {
            vpnPermission.launch(consent)
        } else {
            JevVpnService.start(this)
        }
    }

    private fun setToggle(on: Boolean) {
        suppressToggle = true
        binding.toggleSwitch.isChecked = on
        suppressToggle = false

        binding.statusText.setText(if (on) R.string.status_on else R.string.status_off)
        binding.statusDetail.setText(
            if (on) R.string.status_on_detail else R.string.status_off_detail
        )
    }

    private fun renderStats() {
        binding.queriesValue.text = Stats.queries.get().toString()
        binding.blockedValue.text = Stats.blocked.get().toString()
        binding.domainsValue.text = domainCount.toString()
    }

    private fun runReload() {
        lifecycleScope.launch {
            domainCount = withContext(Dispatchers.IO) { store.loadInto(DomainSet()) }
            renderStats()
            showMessage(getString(R.string.update_ok, domainCount))
            if (JevVpnService.isRunning) JevVpnService.reload(this@MainActivity)
        }
    }

    private fun runUpdate() {
        binding.updateButton.isEnabled = false
        showMessage(getString(R.string.update_running))
        lifecycleScope.launch {
            val result = store.update()
            binding.updateButton.isEnabled = true
            result
                .onSuccess { count ->
                    domainCount = count
                    renderStats()
                    showMessage(getString(R.string.update_ok, count))
                    if (JevVpnService.isRunning) JevVpnService.reload(this@MainActivity)
                }
                .onFailure { error ->
                    showMessage(
                        getString(R.string.err_update_failed, error.message ?: "unknown")
                    )
                }
        }
    }

    private fun showMessage(text: String) {
        binding.messageText.text = text
    }
}
