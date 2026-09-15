package com.accuvis.app.models

import java.time.Instant
import java.util.UUID

enum class EyeSelection(val displayName: String, val code: String) {
    OD("Right Eye", "OD"),
    OS("Left Eye", "OS"),
    OU("Both Eyes (Binocular)", "OU")
}

data class Patient(
    val id: String = UUID.randomUUID().toString(),
    val mrn: String, // Medical Record Number
    val fullName: String,
    val age: Int,
    val gender: String,
    val notes: String = "",
    val activeEye: EyeSelection = EyeSelection.OU,
    val createdAt: Instant = Instant.now(),
    val lastExamAt: Instant? = null
)
