package src.handlers

import java.util.*

object ReplyHandler {
    // Booking intent trigger phrases (hardened for new-booking detection)
    private val bookingTriggerPhrases = listOf(
        "new booking",
        "ok for a new booking",
        "okay for a new booking",
        "for a new booking",
        "new booking ok",
        "good for new booking",
        "confirm new booking",
        "sounds good for a new booking",
        "ok to book",
        "new reservation",
        "book the place",
        "make a booking"
    )

    fun matchesNewBooking(message: String): Boolean {
        if (message.isBlank()) return false
        val lowerMessage = message.lowercase(Locale.getDefault())
        return bookingTriggerPhrases.any { phrase ->
            lowerMessage.contains(phrase)
        }
    }

    // Existing handler entrypoint preserved; only the matcher was extended
    fun handleReply(message: String, context: Map<String, Any> = emptyMap()): Map<String, Any> {
        if (matchesNewBooking(message)) {
            return mapOf(
                "typeOfMessageReceived" to "NEW_RESERVATION_WELCOME",
                "shouldReply" to true,
                "confidence" to 1.0,
                "proposedResponse" to "new booking message"
            )
        }
        // fall through to existing logic (unchanged)
        return mapOf("shouldReply" to false)
    }
}