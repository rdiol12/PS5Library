package com.ps5library.companion.data

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

interface ApiService {

    @GET("api/v1/service-info")
    suspend fun serviceInfo(): ServiceInfo

    @POST("api/v1/auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("api/v1/auth/register")
    suspend fun register(@Body body: LoginRequest): LoginResponse

    @POST("api/v1/auth/logout")
    suspend fun logout(): Acknowledgement

    @GET("api/v1/catalog")
    suspend fun catalog(): List<Game>

    @GET("api/v1/consoles")
    suspend fun consoles(): List<Console>

    @GET("api/v1/jobs")
    suspend fun jobs(): List<Job>

    @GET("api/v1/installations")
    suspend fun installations(): List<Installation>

    @POST("api/v1/jobs/{id}/control")
    suspend fun controlJob(@Path("id") id: String, @Body body: JobControl): Acknowledgement

    @DELETE("api/v1/jobs/{id}")
    suspend fun dismissJob(@Path("id") id: String): Acknowledgement
}
